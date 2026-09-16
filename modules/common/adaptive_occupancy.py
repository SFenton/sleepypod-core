"""Stateful adaptive occupancy detection for named-channel capSense data.

The detector is shared by replay analysis and the production occupancy
runtime. It reports sustained surface load, not confirmed person presence.
"""

import json
import math
import sqlite3
import statistics
from dataclasses import asdict, dataclass
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


Side = str
Channels = Tuple[float, float, float]
ALGORITHM_VERSION = "adaptive-cap-v3"
COMPATIBLE_CHECKPOINT_VERSIONS = {
    "adaptive-cap-v1",
    "adaptive-cap-v2",
    ALGORITHM_VERSION,
}


@dataclass(frozen=True)
class DetectorConfig:
    """Conservative defaults derived from named-channel field observations."""

    relative_scale: float = 0.05
    minimum_scale: float = 40.0
    enter_score: float = 4.0
    exit_score: float = 1.5
    minimum_peak_score: float = 2.5
    minimum_entry_velocity: float = 3.0
    entry_velocity_window_seconds: float = 60.0
    entry_dwell_seconds: float = 10.0
    exit_dwell_seconds: float = 20.0
    baseline_time_constant_seconds: float = 1800.0
    maximum_gap_seconds: float = 30.0
    coupling_step_ratio: float = 0.45
    coupling_step_minimum: float = 2.5
    independent_entry_score: float = 8.0
    inner_zone_dominance_ratio: float = 0.75
    maximum_non_inner_score: float = 2.25
    minimum_encroachment_velocity: float = 1.0
    independent_non_inner_velocity: float = 2.5
    coupled_exit_window_seconds: float = 60.0
    coupled_exit_dwell_seconds: float = 60.0
    weak_single_channel_exit_dwell_seconds: float = 900.0


@dataclass(frozen=True)
class Measurement:
    values: Channels
    channel_scores: Channels
    channel_load_velocity_scores: Channels
    channel_unload_velocity_scores: Channels
    score: float
    peak_score: float
    loaded_channels: int
    step_score: float
    load_velocity_score: float
    unload_velocity_score: float
    entry_velocity_supported: bool
    entry_impulse_age_seconds: Optional[float]
    entry_candidate: bool


@dataclass(frozen=True)
class Decision:
    side: Side
    timestamp: float
    occupied: bool
    changed: bool
    edge_timestamp: Optional[float]
    score: float
    peak_score: float
    loaded_channels: int
    step_score: float
    load_velocity_score: float
    unload_velocity_score: float
    entry_velocity_supported: bool
    entry_impulse_age_seconds: Optional[float]
    channel_scores: Channels
    channel_load_velocity_scores: Channels
    channel_unload_velocity_scores: Channels
    reason: str
    classification: str
    person_present: Optional[bool]
    coupled: bool
    baseline: Channels


def _channels(values: Sequence[float]) -> Channels:
    if len(values) != 3:
        raise ValueError("named-channel capSense requires exactly three channels")
    channels = tuple(float(value) for value in values)
    if not all(math.isfinite(value) for value in channels):
        raise ValueError("capSense channels must be finite")
    return channels  # type: ignore[return-value]


def _median_channels(samples: Sequence[Sequence[float]]) -> Channels:
    if len(samples) < 3:
        raise ValueError("at least three empty samples are required")
    normalized = [_channels(sample) for sample in samples]
    return tuple(
        float(statistics.median(sample[index] for sample in normalized))
        for index in range(3)
    )  # type: ignore[return-value]


class AdaptiveCapSide:
    """One side of the adaptive detector.

    Presence uses positive-only load relative to an explicit empty baseline.
    This avoids treating downward thermal drift as occupancy. A relative raw
    scale floor prevents a very quiet calibration window from making tiny
    changes look enormous.
    """

    def __init__(
        self,
        side: Side,
        empty_samples: Sequence[Sequence[float]],
        config: Optional[DetectorConfig] = None,
    ):
        if side not in ("left", "right"):
            raise ValueError("side must be left or right")
        self.side = side
        self.config = config or DetectorConfig()
        self.baseline = list(_median_channels(empty_samples))
        self.occupied = False
        self._pending_state: Optional[bool] = None
        self._pending_since: Optional[float] = None
        self._previous_values: Optional[Channels] = tuple(self.baseline)  # type: ignore[arg-type]
        self._last_timestamp: Optional[float] = None
        self._last_entry_impulse_at: Optional[float] = None
        self.last_exit_observed_at: Optional[float] = None
        self._weak_single_channel_since: Optional[float] = None

    def _scales(self) -> Channels:
        return tuple(
            max(abs(value) * self.config.relative_scale, self.config.minimum_scale)
            for value in self.baseline
        )  # type: ignore[return-value]

    def measure(self, timestamp: float, values: Sequence[float]) -> Measurement:
        current = _channels(values)
        if self._last_timestamp is not None:
            if timestamp <= self._last_timestamp:
                raise ValueError("capSense timestamps must increase")
            if timestamp - self._last_timestamp > self.config.maximum_gap_seconds:
                self._pending_state = None
                self._pending_since = None
                self._previous_values = None
                self._last_entry_impulse_at = None

        scales = self._scales()
        scores = tuple(
            max(0.0, (value - baseline) / scale)
            for value, baseline, scale in zip(current, self.baseline, scales)
        )
        velocity_available = self._previous_values is not None
        if not velocity_available:
            load_velocity_scores = (0.0, 0.0, 0.0)
            unload_velocity_scores = (0.0, 0.0, 0.0)
        else:
            load_velocity_scores = tuple(
                max(0.0, (value - previous) / scale)
                for value, previous, scale in zip(current, self._previous_values, scales)
            )
            unload_velocity_scores = tuple(
                max(0.0, (previous - value) / scale)
                for value, previous, scale in zip(current, self._previous_values, scales)
            )
        load_velocity_score = sum(load_velocity_scores)
        unload_velocity_score = sum(unload_velocity_scores)
        step_score = load_velocity_score + unload_velocity_score
        if load_velocity_score >= self.config.minimum_entry_velocity:
            self._last_entry_impulse_at = timestamp
        entry_impulse_age = (
            timestamp - self._last_entry_impulse_at
            if self._last_entry_impulse_at is not None else None
        )
        entry_velocity_supported = (
            entry_impulse_age is not None
            and entry_impulse_age <= self.config.entry_velocity_window_seconds
        )
        score = sum(scores)
        peak_score = max(scores)
        loaded_channels = sum(value >= 1.0 for value in scores)
        entry_candidate = (
            score >= self.config.enter_score
            and (
                peak_score >= self.config.minimum_peak_score
                or loaded_channels >= 2
            )
            and (
                entry_velocity_supported
                or (
                    not velocity_available
                    and score >= self.config.independent_entry_score
                )
            )
        )
        return Measurement(
            values=current,
            channel_scores=scores,
            channel_load_velocity_scores=load_velocity_scores,
            channel_unload_velocity_scores=unload_velocity_scores,
            score=score,
            peak_score=peak_score,
            loaded_channels=loaded_channels,
            step_score=step_score,
            load_velocity_score=load_velocity_score,
            unload_velocity_score=unload_velocity_score,
            entry_velocity_supported=entry_velocity_supported,
            entry_impulse_age_seconds=entry_impulse_age,
            entry_candidate=entry_candidate,
        )

    def update(
        self,
        timestamp: float,
        measurement: Measurement,
        entry_suppression_reason: Optional[str] = None,
        exit_dwell_override: Optional[float] = None,
    ) -> Decision:
        coupled = bool(
            entry_suppression_reason
            and measurement.entry_candidate
            and not self.occupied
        )
        if self.occupied:
            weak_single_channel = (
                measurement.loaded_channels <= 1
                and measurement.score < self.config.independent_entry_score
                and not measurement.entry_velocity_supported
            )
            if weak_single_channel:
                if self._weak_single_channel_since is None:
                    self._weak_single_channel_since = timestamp
            else:
                self._weak_single_channel_since = None
            weak_single_channel_timed_out = (
                self._weak_single_channel_since is not None
                and timestamp - self._weak_single_channel_since
                >= self.config.weak_single_channel_exit_dwell_seconds
            )
            raw_present = (
                measurement.score > self.config.exit_score
                and not weak_single_channel_timed_out
            )
            if weak_single_channel_timed_out:
                reason = "weak_single_channel_exit_candidate"
            elif raw_present:
                reason = "occupied_hold"
            elif exit_dwell_override is not None:
                coupled = True
                reason = "coupled_exit_candidate"
            else:
                reason = "exit_candidate"
        else:
            self._weak_single_channel_since = None
            raw_present = (
                measurement.entry_candidate and entry_suppression_reason is None
            )
            if coupled:
                reason = entry_suppression_reason or "coupled_entry_suppressed"
            else:
                reason = "entry_candidate" if raw_present else "empty_hold"

        changed = False
        edge_timestamp = None
        if raw_present == self.occupied:
            self._pending_state = None
            self._pending_since = None
        elif self._pending_state != raw_present:
            self._pending_state = raw_present
            self._pending_since = timestamp
        else:
            dwell = (
                self.config.entry_dwell_seconds
                if raw_present
                else exit_dwell_override or self.config.exit_dwell_seconds
            )
            if self._pending_since is not None and timestamp - self._pending_since >= dwell:
                self.occupied = raw_present
                changed = True
                edge_timestamp = self._pending_since
                reason = "entry" if raw_present else "exit"
                if not raw_present:
                    self.last_exit_observed_at = timestamp
                    self._last_entry_impulse_at = None
                    self._weak_single_channel_since = None
                self._pending_state = None
                self._pending_since = None

        if not self.occupied and measurement.score <= self.config.exit_score:
            self._adapt_baseline(timestamp, measurement.values)

        self._previous_values = measurement.values
        self._last_timestamp = timestamp
        if self.occupied:
            classification = "loaded_unconfirmed"
            person_present = None
        elif entry_suppression_reason is not None:
            classification = entry_suppression_reason
            person_present = False
        else:
            classification = "empty"
            person_present = False
        return Decision(
            side=self.side,
            timestamp=timestamp,
            occupied=self.occupied,
            changed=changed,
            edge_timestamp=edge_timestamp,
            score=measurement.score,
            peak_score=measurement.peak_score,
            loaded_channels=measurement.loaded_channels,
            step_score=measurement.step_score,
            load_velocity_score=measurement.load_velocity_score,
            unload_velocity_score=measurement.unload_velocity_score,
            entry_velocity_supported=measurement.entry_velocity_supported,
            entry_impulse_age_seconds=measurement.entry_impulse_age_seconds,
            channel_scores=measurement.channel_scores,
            channel_load_velocity_scores=measurement.channel_load_velocity_scores,
            channel_unload_velocity_scores=measurement.channel_unload_velocity_scores,
            reason=reason,
            classification=classification,
            person_present=person_present,
            coupled=coupled,
            baseline=tuple(self.baseline),  # type: ignore[arg-type]
        )

    def _adapt_baseline(self, timestamp: float, values: Channels) -> None:
        if self._last_timestamp is None:
            return
        elapsed = min(timestamp - self._last_timestamp, self.config.maximum_gap_seconds)
        if elapsed <= 0:
            return
        alpha = 1.0 - math.exp(
            -elapsed / self.config.baseline_time_constant_seconds
        )
        for index, value in enumerate(values):
            self.baseline[index] += alpha * (value - self.baseline[index])

    def snapshot(self) -> Dict[str, object]:
        return {
            "baseline": list(self.baseline),
            "occupied": self.occupied,
            "pending_state": self._pending_state,
            "pending_since": self._pending_since,
            "previous_values": (
                list(self._previous_values)
                if self._previous_values is not None
                else None
            ),
            "last_timestamp": self._last_timestamp,
            "last_entry_impulse_at": self._last_entry_impulse_at,
            "last_exit_observed_at": self.last_exit_observed_at,
            "weak_single_channel_since": self._weak_single_channel_since,
        }

    def restore(self, snapshot: Mapping[str, object]) -> None:
        self.baseline = list(_channels(snapshot["baseline"]))  # type: ignore[arg-type]
        self.occupied = bool(snapshot["occupied"])
        pending_state = snapshot.get("pending_state")
        self._pending_state = (
            bool(pending_state) if pending_state is not None else None
        )
        self._pending_since = _optional_float(snapshot.get("pending_since"))
        previous_values = snapshot.get("previous_values")
        self._previous_values = (
            _channels(previous_values)  # type: ignore[arg-type]
            if previous_values is not None
            else None
        )
        self._last_timestamp = _optional_float(snapshot.get("last_timestamp"))
        self._last_entry_impulse_at = _optional_float(
            snapshot.get("last_entry_impulse_at")
        )
        self.last_exit_observed_at = _optional_float(
            snapshot.get("last_exit_observed_at")
        )
        self._weak_single_channel_since = _optional_float(
            snapshot.get("weak_single_channel_since")
        )


class AdaptiveCapPair:
    """Evaluate both sides together so abrupt cross-bed coupling is visible."""

    def __init__(
        self,
        left_empty: Sequence[Sequence[float]],
        right_empty: Sequence[Sequence[float]],
        config: Optional[DetectorConfig] = None,
    ):
        self.config = config or DetectorConfig()
        self.sides = {
            "left": AdaptiveCapSide("left", left_empty, self.config),
            "right": AdaptiveCapSide("right", right_empty, self.config),
        }
        self._encroachment_active = {"left": False, "right": False}

    def update(
        self,
        timestamp: float,
        left: Sequence[float],
        right: Sequence[float],
    ) -> Dict[Side, Decision]:
        measurements = {
            "left": self.sides["left"].measure(timestamp, left),
            "right": self.sides["right"].measure(timestamp, right),
        }
        entry_suppression: Dict[Side, Optional[str]] = {
            "left": None,
            "right": None,
        }
        exit_dwell: Dict[Side, Optional[float]] = {"left": None, "right": None}
        for side, other in (("left", "right"), ("right", "left")):
            detector = self.sides[side]
            own = measurements[side]
            peer = measurements[other]
            if detector.occupied:
                self._encroachment_active[side] = False
                continue
            non_inner_score = own.channel_scores[0] + own.channel_scores[1]
            non_inner_velocity = (
                own.channel_load_velocity_scores[0]
                + own.channel_load_velocity_scores[1]
            )
            inner_dominance = (
                own.score > 0
                and own.channel_scores[2] / own.score
                >= self.config.inner_zone_dominance_ratio
            )
            encroachment_shape = (
                self.sides[other].occupied
                and inner_dominance
                and non_inner_score <= self.config.maximum_non_inner_score
            )
            if own.score <= self.config.exit_score:
                self._encroachment_active[side] = False
            elif (
                self._encroachment_active[side]
                and non_inner_score >= self.config.maximum_non_inner_score
                and non_inner_velocity
                >= self.config.independent_non_inner_velocity
            ):
                self._encroachment_active[side] = False
            elif (
                not self._encroachment_active[side]
                and encroachment_shape
                and (
                    own.load_velocity_score
                    >= self.config.minimum_encroachment_velocity
                    or own.score >= self.config.independent_entry_score
                )
            ):
                self._encroachment_active[side] = True

            if not own.entry_candidate:
                continue
            if self._encroachment_active[side]:
                entry_suppression[side] = "inner_zone_encroachment"
                continue
            if own.score >= self.config.independent_entry_score:
                continue
            if (
                peer.step_score >= self.config.coupling_step_minimum
                and own.step_score < peer.step_score * self.config.coupling_step_ratio
            ):
                entry_suppression[side] = "coupled_entry_suppressed"

        for side, other in (("left", "right"), ("right", "left")):
            detector = self.sides[side]
            peer = self.sides[other]
            if not detector.occupied or measurements[side].score > self.config.exit_score:
                continue
            if (
                peer.last_exit_observed_at is not None
                and timestamp - peer.last_exit_observed_at
                <= self.config.coupled_exit_window_seconds
            ):
                exit_dwell[side] = self.config.coupled_exit_dwell_seconds

        return {
            side: self.sides[side].update(
                timestamp,
                measurements[side],
                entry_suppression_reason=entry_suppression[side],
                exit_dwell_override=exit_dwell[side],
            )
            for side in ("left", "right")
        }

    def snapshot(self) -> Dict[str, object]:
        return {
            "algorithm_version": ALGORITHM_VERSION,
            "config": asdict(self.config),
            "encroachment_active": dict(self._encroachment_active),
            "sides": {
                side: detector.snapshot()
                for side, detector in self.sides.items()
            },
        }

    @classmethod
    def from_snapshot(cls, snapshot: Mapping[str, object]) -> "AdaptiveCapPair":
        if snapshot.get("algorithm_version") not in COMPATIBLE_CHECKPOINT_VERSIONS:
            raise ValueError("adaptive occupancy checkpoint version is unsupported")
        config_data = snapshot.get("config")
        sides_data = snapshot.get("sides")
        if not isinstance(config_data, Mapping) or not isinstance(sides_data, Mapping):
            raise ValueError("adaptive occupancy checkpoint is malformed")

        config = DetectorConfig(**dict(config_data))
        left_data = sides_data.get("left")
        right_data = sides_data.get("right")
        if not isinstance(left_data, Mapping) or not isinstance(right_data, Mapping):
            raise ValueError("adaptive occupancy checkpoint is missing side state")
        left_baseline = _channels(left_data["baseline"])  # type: ignore[arg-type]
        right_baseline = _channels(right_data["baseline"])  # type: ignore[arg-type]
        pair = cls([left_baseline] * 3, [right_baseline] * 3, config=config)
        pair.sides["left"].restore(left_data)
        pair.sides["right"].restore(right_data)

        encroachment = snapshot.get("encroachment_active")
        if isinstance(encroachment, Mapping):
            pair._encroachment_active = {
                "left": bool(encroachment.get("left", False)),
                "right": bool(encroachment.get("right", False)),
            }
        return pair


def _optional_float(value: object) -> Optional[float]:
    if value is None:
        return None
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("checkpoint timestamp must be finite")
    return number


def analyze_database(
    connection: sqlite3.Connection,
    start: float,
    end: float,
    baseline_start: float,
    baseline_end: float,
    config: Optional[DetectorConfig] = None,
    include_decisions: bool = False,
) -> Dict[str, object]:
    """Replay downsampled capSense rows through the adaptive detector."""
    if not baseline_start < baseline_end <= start < end:
        raise ValueError("expected baseline_start < baseline_end <= start < end")

    rows = connection.execute(
        """SELECT side, timestamp, zones
             FROM cap_sense_frames
            WHERE timestamp BETWEEN ? AND ?
              AND zones IS NOT NULL
            ORDER BY timestamp, side""",
        (baseline_start, end),
    ).fetchall()

    baseline_samples: Dict[Side, List[Channels]] = {"left": [], "right": []}
    paired: Dict[float, Dict[Side, Channels]] = {}
    for side, timestamp, encoded in rows:
        if side not in baseline_samples:
            continue
        values = _channels(json.loads(encoded))
        ts = float(timestamp)
        if baseline_start <= ts < baseline_end:
            baseline_samples[side].append(values)
        if start <= ts <= end:
            paired.setdefault(ts, {})[side] = values

    detector = AdaptiveCapPair(
        baseline_samples["left"],
        baseline_samples["right"],
        config=config,
    )
    transitions = []
    decision_trace = []
    latest_decisions: Dict[Side, Decision] = {}
    decisions = 0
    skipped_unpaired = 0
    for timestamp, sides in sorted(paired.items()):
        if "left" not in sides or "right" not in sides:
            skipped_unpaired += 1
            continue
        decisions += 2
        pair_decisions = detector.update(
            timestamp,
            sides["left"],
            sides["right"],
        )
        latest_decisions.update(pair_decisions)
        for decision in pair_decisions.values():
            if include_decisions:
                decision_trace.append(asdict(decision))
            if decision.changed:
                transitions.append(asdict(decision))

    report = {
        "mode": "shadow",
        "production_behavior_changed": False,
        "window": {"start": start, "end": end},
        "baseline_window": {"start": baseline_start, "end": baseline_end},
        "initial_baselines": {
            side: list(_median_channels(samples))
            for side, samples in baseline_samples.items()
        },
        "final_baselines": {
            side: list(detector.sides[side].baseline)
            for side in ("left", "right")
        },
        "decisions": decisions,
        "skipped_unpaired_timestamps": skipped_unpaired,
        "transitions": transitions,
        "final_state": {
            side: detector.sides[side].occupied
            for side in ("left", "right")
        },
        "final_classification": {
            side: (
                latest_decisions[side].classification
                if side in latest_decisions
                else "empty"
            )
            for side in ("left", "right")
        },
        "final_person_present": {
            side: (
                latest_decisions[side].person_present
                if side in latest_decisions
                else False
            )
            for side in ("left", "right")
        },
    }
    if include_decisions:
        report["decision_trace"] = decision_trace
    return report
