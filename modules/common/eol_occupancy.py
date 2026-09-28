"""Streaming evidence-of-life (EoL) occupancy detector.

A causal, standard-library-only port of the validated ``eol_v4.run`` state
machine.  ``modules/eol-occupancy`` runs it live for the primary MQTT occupancy
entities, and ``common.eol_replay`` runs the same rules over archived study
chunks.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple


ALGORITHM_VERSION = "eol-occupancy-v4"
SNAPSHOT_VERSION = 1

EMPTY = "empty"
PROVISIONAL = "provisional"
OCCUPIED = "occupied"
SIDES = ("left", "right")
_CAP_SENTINEL = 2147483646.0

# Generated once with:
# scipy.signal.butter(3, [1.0, 10.0], btype="band", fs=25, output="sos")
# The matching unit-step initial states from scipy.signal.sosfilt_zi are below.
SOS_MOTION = (
    (
        0.40189898133052832,
        0.80379796266105663,
        0.40189898133052832,
        1.0,
        1.2545683954713027,
        0.5631841082337592,
    ),
    (
        1.0,
        0.0,
        -1.0,
        1.0,
        -0.28164801021172098,
        -0.36002215309575664,
    ),
    (
        1.0,
        -2.0,
        1.0,
        1.0,
        -1.7297350097088182,
        0.78797644158862368,
    ),
)
_SOS_ZI_UNIT = (
    (0.16862519466018988, 0.080588832049395487),
    (-0.57052417599071803, -0.57052417599071803),
    (0.0, 0.0),
)

_Channels = Tuple[float, float, float]
_FilterState = List[List[float]]


@dataclass(frozen=True)
class EolConfig:
    """Thresholds from the validated v4 detector and streaming fallbacks."""

    enter_step: float = 250.0
    enter_step_channel: float = 120.0
    enter_motion: float = 80e3
    enter_dominance: float = 1.0
    confirm_after_s: int = 20
    confirm_life_s: int = 15
    provisional_timeout_s: int = 150
    exit_step: float = 300.0
    exit_step_channel: float = 150.0
    exit_confirm_window: int = 60
    exit_confirm_run: int = 3
    collapse: float = 0.35
    quiet_energy: float = 20e3
    coupling_ratio: float = 0.30
    ref_return: float = 0.6
    ref_margin: float = 250.0
    mv_short_absent: float = 8.0
    mv_person: float = 9.0
    mv_absent: float = 7.0
    life_energy: float = 60e3
    life_dominance: float = 0.6
    load_person: float = 300.0
    load_non_inner: float = 150.0
    slow_entry_s: int = 180
    unloaded_absence_s: int = 180
    loaded_absence_s: int = 600
    bootstrap_s: int = 60
    gap_reset_s: int = 600
    ref_tau_s: float = 180.0
    degraded_exit_confirm_run: int = 10
    degraded_mv_short_absent: float = 6.0
    degraded_unloaded_absence_s: int = 300


@dataclass(frozen=True)
class Decision:
    """One side's fast and confirmed state at a unique capSense sample."""

    side: str
    timestamp: float
    state: str
    occupied: bool
    confirmed: bool
    event: Optional[str]
    degraded: bool
    diagnostics: Dict[str, Optional[float]]


@dataclass
class _SideState:
    state: str = EMPTY
    reference: Optional[_Channels] = None
    life_run: int = 0
    unloaded_quiet_run: int = 0
    loaded_dead_run: int = 0
    boot_empty_run: int = 0
    boot_life_run: int = 0
    provisional_since: Optional[float] = None
    provisional_life: int = 0
    candidate_at: Optional[float] = None
    candidate_erest: float = 0.0
    candidate_prev_load: Optional[float] = None
    exit_confirm_run: int = 0
    hold: int = 0
    last_valid_cap: Optional[float] = None
    cap_samples: List[Tuple[float, _Channels]] = field(default_factory=list)
    center_deltas: List[Tuple[float, float]] = field(default_factory=list)
    energies: List[Tuple[float, float]] = field(default_factory=list)
    piezo_zi: Optional[_FilterState] = None
    previous_piezo_second: Optional[float] = None


def _finite_timestamp(value: float) -> float:
    timestamp = float(value)
    if not math.isfinite(timestamp):
        raise ValueError("server timestamp must be finite")
    return timestamp


def _channels(values: Sequence[float]) -> _Channels:
    if len(values) != 3:
        raise ValueError("capSense requires exactly three channels")
    try:
        parsed = tuple(float(value) for value in values)
    except (TypeError, ValueError) as exc:
        raise ValueError("capSense channels must be numeric") from exc
    return parsed  # type: ignore[return-value]


def _valid_cap(values: _Channels, good: bool) -> bool:
    return bool(good) and all(
        math.isfinite(value) and value < _CAP_SENTINEL
        for value in values
    )


def _median(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return float((ordered[middle - 1] + ordered[middle]) / 2.0)


def _median_channels(
    samples: Sequence[Tuple[float, _Channels]],
    start: float,
    end: float,
    minimum: int,
) -> Optional[_Channels]:
    selected = [values for timestamp, values in samples if start < timestamp <= end]
    if len(selected) < minimum:
        return None
    medians = tuple(
        _median([values[index] for values in selected])
        for index in range(3)
    )
    if any(value is None for value in medians):
        return None
    return medians  # type: ignore[return-value]


def _window_median(
    values: Sequence[Tuple[float, float]],
    start: float,
    end: float,
    minimum: int,
) -> Optional[float]:
    selected = [value for timestamp, value in values if start < timestamp <= end]
    if len(selected) < minimum:
        return None
    return _median(selected)


def _window_max(
    values: Sequence[Tuple[float, float]],
    start: float,
    end: float,
    minimum: int,
) -> Optional[float]:
    selected = [value for timestamp, value in values if start < timestamp <= end]
    if len(selected) < minimum:
        return None
    return float(max(selected))


def _percentile_linear(values: Sequence[float], quantile: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * quantile
    lower = int(math.floor(index))
    upper = int(math.ceil(index))
    if lower == upper:
        return float(ordered[lower])
    fraction = index - lower
    return float(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction)


def _window_percentile(
    values: Sequence[Tuple[float, float]],
    start: float,
    end: float,
    minimum: int,
    quantile: float,
) -> Optional[float]:
    selected = [value for timestamp, value in values if start < timestamp <= end]
    if len(selected) < minimum:
        return None
    return _percentile_linear(selected, quantile)


def _population_std(values: Sequence[float]) -> float:
    mean = math.fsum(values) / len(values)
    return math.sqrt(math.fsum((value - mean) ** 2 for value in values) / len(values))


def _copy_filter_state(state: _FilterState) -> _FilterState:
    return [[row[0], row[1]] for row in state]


def _run_sos(
    samples: Sequence[float],
    state: _FilterState,
) -> Tuple[List[float], _FilterState]:
    current_state = _copy_filter_state(state)
    filtered: List[float] = []
    for sample in samples:
        value = float(sample)
        for index, coefficients in enumerate(SOS_MOTION):
            b0, b1, b2, _a0, a1, a2 = coefficients
            z1, z2 = current_state[index]
            output = b0 * value + z1
            current_state[index][0] = b1 * value - a1 * output + z2
            current_state[index][1] = b2 * value - a2 * output
            value = output
        filtered.append(value)
    return filtered, current_state


def _new_filter_state(first_sample: float) -> _FilterState:
    state = [
        [unit_z1 * first_sample, unit_z2 * first_sample]
        for unit_z1, unit_z2 in _SOS_ZI_UNIT
    ]
    _ignored, warmed = _run_sos([first_sample] * 50, state)
    return warmed


def _optional_float(value: object, name: str) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("%s must be numeric" % name) from exc
    if not math.isfinite(parsed):
        raise ValueError("%s must be finite" % name)
    return parsed


class EolPair:
    """Causal two-side EoL state machine with per-second piezo filtering."""

    def __init__(self, config: Optional[EolConfig] = None):
        self.config = config or EolConfig()
        self._sides: Dict[str, _SideState] = {
            side: _SideState() for side in SIDES
        }
        self._last_cap_timestamp: Optional[float] = None
        self._last_frame_values: Optional[Tuple[float, ...]] = None

    def update_piezo_raw(
        self,
        server_ts: float,
        left_samples: Sequence[int],
        right_samples: Sequence[int],
    ) -> None:
        """Accept one raw 500 Hz piezo second per side."""

        if len(left_samples) != 500 or len(right_samples) != 500:
            raise ValueError("raw piezo messages require exactly 500 samples per side")

        left = [float(sample) for sample in left_samples]
        right = [float(sample) for sample in right_samples]
        self.update_piezo_blocks(
            server_ts,
            _block_means(left),
            _block_means(right),
            any(abs(sample) >= _CAP_SENTINEL for sample in left),
            any(abs(sample) >= _CAP_SENTINEL for sample in right),
        )

    def update_piezo_blocks(
        self,
        server_ts: float,
        left_blocks25: Sequence[float],
        right_blocks25: Sequence[float],
        left_saturated: bool,
        right_saturated: bool,
    ) -> None:
        """Accept one pre-decimated 25 Hz piezo second per side."""

        timestamp = _finite_timestamp(server_ts)
        if len(left_blocks25) != 25 or len(right_blocks25) != 25:
            raise ValueError("pre-decimated piezo messages require 25 blocks per side")

        try:
            left = [float(value) for value in left_blocks25]
            right = [float(value) for value in right_blocks25]
        except (TypeError, ValueError) as exc:
            raise ValueError("piezo blocks must be numeric") from exc

        second = float(round(timestamp))
        self._update_piezo_side(
            "left",
            second,
            left,
            bool(left_saturated) or not all(math.isfinite(value) for value in left),
        )
        self._update_piezo_side(
            "right",
            second,
            right,
            bool(right_saturated) or not all(math.isfinite(value) for value in right),
        )

    def update_cap(
        self,
        server_ts: float,
        left: Sequence[float],
        right: Sequence[float],
        left_good: bool = True,
        right_good: bool = True,
    ) -> Optional[Dict[str, Decision]]:
        """Evaluate both sides once for a unique capSense frame.

        Firmware commonly publishes each capSense frame twice.  A repeated set
        of six channels is ignored before it can affect feature windows or
        one-Hz-style run counters.
        """

        timestamp = _finite_timestamp(server_ts)
        left_values = _channels(left)
        right_values = _channels(right)
        frame_values = left_values + right_values
        if (
            self._last_frame_values is not None
            and _same_frame(self._last_frame_values, frame_values)
        ):
            return None
        if (
            self._last_cap_timestamp is not None
            and timestamp <= self._last_cap_timestamp
        ):
            raise ValueError("unique capSense timestamps must increase")

        self._last_cap_timestamp = timestamp
        self._last_frame_values = (
            frame_values if all(math.isfinite(value) for value in frame_values) else None
        )
        valid = {
            "left": _valid_cap(left_values, left_good),
            "right": _valid_cap(right_values, right_good),
        }
        cap_values = {"left": left_values, "right": right_values}
        features = {
            side: self._energy_features(side, timestamp)
            for side in SIDES
        }
        piezo_ok = (
            features["left"]["e20"] is not None
            and features["right"]["e20"] is not None
        )

        decisions: Dict[str, Decision] = {}
        for side, other in (("left", "right"), ("right", "left")):
            if valid[side]:
                decisions[side] = self._evaluate_valid_cap(
                    side,
                    other,
                    timestamp,
                    cap_values[side],
                    features[side],
                    features[other],
                    piezo_ok,
                )
            else:
                decisions[side] = self._decision(
                    side=side,
                    timestamp=timestamp,
                    event=None,
                    piezo_ok=piezo_ok,
                    load=None,
                    mv60=None,
                    e20_own=features[side]["e20"],
                    e20_partner=features[other]["e20"],
                )
        return decisions

    def snapshot(self) -> dict:
        """Return a JSON-serializable, versioned checkpoint."""

        return {
            "algorithm_version": ALGORITHM_VERSION,
            "snapshot_version": SNAPSHOT_VERSION,
            "config": asdict(self.config),
            "last_cap_timestamp": self._last_cap_timestamp,
            "last_frame_values": (
                list(self._last_frame_values)
                if self._last_frame_values is not None
                else None
            ),
            "sides": {
                side: self._snapshot_side(self._sides[side])
                for side in SIDES
            },
        }

    @classmethod
    def from_snapshot(cls, snapshot: Mapping[str, object]) -> "EolPair":
        """Restore a checkpoint made by :meth:`snapshot`."""

        if snapshot.get("algorithm_version") != ALGORITHM_VERSION:
            raise ValueError("EoL occupancy checkpoint version is unsupported")
        if snapshot.get("snapshot_version") != SNAPSHOT_VERSION:
            raise ValueError("EoL occupancy checkpoint schema is unsupported")
        config_data = snapshot.get("config")
        sides_data = snapshot.get("sides")
        if not isinstance(config_data, Mapping) or not isinstance(sides_data, Mapping):
            raise ValueError("EoL occupancy checkpoint is malformed")
        try:
            config = EolConfig(**dict(config_data))
        except (TypeError, ValueError) as exc:
            raise ValueError("EoL occupancy checkpoint has invalid config") from exc

        pair = cls(config=config)
        pair._last_cap_timestamp = _optional_float(
            snapshot.get("last_cap_timestamp"),
            "last_cap_timestamp",
        )
        frame_values = snapshot.get("last_frame_values")
        if frame_values is not None:
            if not isinstance(frame_values, Sequence) or len(frame_values) != 6:
                raise ValueError("EoL occupancy checkpoint has invalid frame values")
            parsed_frame = tuple(float(value) for value in frame_values)
            if not all(math.isfinite(value) for value in parsed_frame):
                raise ValueError("EoL occupancy checkpoint frame values must be finite")
            pair._last_frame_values = parsed_frame

        for side in SIDES:
            side_data = sides_data.get(side)
            if not isinstance(side_data, Mapping):
                raise ValueError("EoL occupancy checkpoint is missing %s state" % side)
            pair._sides[side] = pair._restore_side(side_data)
        return pair

    def _update_piezo_side(
        self,
        side: str,
        second: float,
        blocks: Sequence[float],
        saturated: bool,
    ) -> None:
        state = self._sides[side]
        previous = state.previous_piezo_second
        if previous is not None and second < previous:
            raise ValueError("piezo timestamps must not move backward")
        state.previous_piezo_second = second
        state.energies = [
            (timestamp, energy)
            for timestamp, energy in state.energies
            if timestamp != second
        ]

        if saturated:
            state.piezo_zi = None
            self._prune_energy(state, second)
            return

        if (
            state.piezo_zi is None
            or previous is None
            or second - previous > 2.0
        ):
            state.piezo_zi = _new_filter_state(blocks[0])
        filtered, state.piezo_zi = _run_sos(blocks, state.piezo_zi)
        state.energies.append((second, _population_std(filtered)))
        self._prune_energy(state, second)

    def _evaluate_valid_cap(
        self,
        side: str,
        other: str,
        timestamp: float,
        values: _Channels,
        own_energy: Dict[str, Optional[float]],
        other_energy: Dict[str, Optional[float]],
        piezo_ok: bool,
    ) -> Decision:
        state = self._sides[side]
        event: Optional[str] = None
        if (
            state.last_valid_cap is not None
            and timestamp - state.last_valid_cap > self.config.gap_reset_s
        ):
            state.life_run = 0
            state.unloaded_quiet_run = 0
            state.loaded_dead_run = 0
            state.candidate_at = None
            event = "gap_resume"
        state.last_valid_cap = timestamp

        previous_sample = state.cap_samples[-1] if state.cap_samples else None
        if (
            previous_sample is not None
            and timestamp - previous_sample[0] <= 1.5
        ):
            state.center_deltas.append(
                (timestamp, abs(values[1] - previous_sample[1][1]))
            )
        state.cap_samples.append((timestamp, values))
        self._prune_cap_history(state, timestamp)

        now = _median_channels(
            state.cap_samples,
            timestamp - 3.0,
            timestamp,
            2,
        )
        prev = _median_channels(
            state.cap_samples,
            timestamp - 31.0,
            timestamp - 10.0,
            10,
        )
        mv60 = _window_median(
            state.center_deltas,
            timestamp - 60.0,
            timestamp,
            30,
        )
        mv10 = _window_median(
            state.center_deltas,
            timestamp - 10.0,
            timestamp,
            6,
        )
        e5 = own_energy["e5"]
        e5_other = other_energy["e5"]
        e20 = own_energy["e20"]
        e20_other = other_energy["e20"]
        emax8 = own_energy["emax8"]
        emax8_other = other_energy["emax8"]
        erest = own_energy["erest"]

        finite_level = now is not None
        step: Optional[_Channels]
        if now is not None and prev is not None:
            step = tuple(now[index] - prev[index] for index in range(3))  # type: ignore[assignment]
            net_step = float(sum(step))
        else:
            step = None
            net_step = 0.0
        motion = mv60 if mv60 is not None else 0.0

        load: Optional[float] = None
        loaded = False
        near_reference = False
        if state.reference is not None and now is not None:
            above = tuple(
                now[index] - state.reference[index]
                for index in range(3)
            )
            load = float(sum(above))
            loaded = (
                load >= self.config.load_person
                and above[0] + above[1] >= self.config.load_non_inner
            )
            near_reference = load <= self.config.ref_margin

        own_e5 = e5 if e5 is not None else 0.0
        other_e5 = e5_other if e5_other is not None else 0.0
        own_e20 = e20 if e20 is not None else 0.0
        other_e20 = e20_other if e20_other is not None else 0.0
        piezo_life = (
            piezo_ok
            and own_e20 >= self.config.life_energy
            and own_e20 >= self.config.life_dominance * other_e20
        )
        bed_dead = (
            piezo_ok
            and own_e20 <= self.config.quiet_energy
            and other_e20 <= self.config.quiet_energy
        )
        quiet = motion <= self.config.mv_absent
        load_step = (
            step is not None
            and net_step >= self.config.enter_step
            and max(step) >= self.config.enter_step_channel
        )
        unload_step = (
            step is not None
            and net_step <= -self.config.exit_step
            and min(step) <= -self.config.exit_step_channel
        )
        if not piezo_ok:
            burst = net_step >= 1.6 * self.config.enter_step
        elif emax8 is not None:
            burst = (
                emax8 >= self.config.enter_motion
                and emax8
                >= self.config.enter_dominance
                * (emax8_other if emax8_other is not None else 0.0)
            )
        else:
            burst = net_step >= 1.6 * self.config.enter_step

        side_life = loaded and motion >= self.config.mv_person
        state.life_run = state.life_run + 1 if side_life else 0
        state.unloaded_quiet_run = (
            state.unloaded_quiet_run + 1
            if near_reference and quiet
            else 0
        )
        state.loaded_dead_run = (
            state.loaded_dead_run + 1
            if quiet and bed_dead
            else 0
        )
        state.hold = max(0, state.hold - 1)

        if state.state == EMPTY:
            if state.reference is None:
                state.boot_empty_run = (
                    state.boot_empty_run + 1
                    if quiet and (bed_dead or not piezo_ok)
                    else 0
                )
                state.boot_life_run = (
                    state.boot_life_run + 1
                    if motion >= self.config.mv_person + 1.0 and piezo_life
                    else 0
                )
                if state.boot_empty_run >= self.config.bootstrap_s and finite_level:
                    state.reference = now
                    event = "reference_bootstrap"
            elif (
                quiet
                and (bed_dead or near_reference or not piezo_ok)
                and finite_level
            ):
                alpha = 1.0 - math.exp(-1.0 / self.config.ref_tau_s)
                state.reference = tuple(
                    reference + alpha * (level - reference)
                    for reference, level in zip(state.reference, now)
                )  # type: ignore[assignment]

            if load_step and burst and not state.hold:
                state.state = PROVISIONAL
                state.provisional_since = timestamp
                state.provisional_life = 0
                state.candidate_at = None
                state.hold = 10
                event = "entry_step"
            elif state.reference is not None and state.life_run >= self.config.slow_entry_s:
                state.state = OCCUPIED
                state.candidate_at = None
                event = "entry_life"
            elif state.reference is None and state.boot_life_run >= self.config.bootstrap_s:
                state.state = OCCUPIED
                event = "entry_bootstrap"
            if state.state != EMPTY:
                state.life_run = 0
                state.unloaded_quiet_run = 0
                state.loaded_dead_run = 0

        elif state.state == PROVISIONAL:
            sustained = loaded or state.reference is None
            if (
                state.provisional_since is not None
                and timestamp - state.provisional_since >= self.config.confirm_after_s
                and sustained
                and (piezo_life or motion >= self.config.mv_person)
            ):
                state.provisional_life += 1
            if state.provisional_life >= self.config.confirm_life_s:
                state.state = OCCUPIED
                state.unloaded_quiet_run = 0
                state.loaded_dead_run = 0
                event = "entry_confirmed"
            elif (
                state.provisional_since is not None
                and timestamp - state.provisional_since >= self.config.provisional_timeout_s
            ):
                state.state = EMPTY
                state.candidate_at = None
                state.life_run = 0
                state.unloaded_quiet_run = 0
                state.loaded_dead_run = 0
                event = "entry_revoked"

        if state.state in (PROVISIONAL, OCCUPIED):
            if unload_step and not state.hold and state.candidate_at is None:
                state.candidate_at = timestamp
                state.exit_confirm_run = 0
                state.candidate_erest = (
                    erest if erest is not None else own_e20
                )
                if state.reference is not None and prev is not None:
                    state.candidate_prev_load = float(
                        sum(
                            prev[index] - state.reference[index]
                            for index in range(3)
                        )
                    )
                else:
                    state.candidate_prev_load = None
            if state.candidate_at is not None:
                reduced_load = (
                    state.candidate_prev_load is not None
                    and state.candidate_prev_load > 0.0
                    and load is not None
                    and load
                    <= (1.0 - self.config.ref_return)
                    * state.candidate_prev_load
                )
                back = near_reference or state.reference is None or reduced_load
                vitals_absent = (not piezo_ok) or (
                    own_e5
                    <= max(
                        self.config.quiet_energy,
                        self.config.coupling_ratio * other_e5,
                    )
                    and own_e5
                    <= max(
                        self.config.quiet_energy,
                        self.config.collapse * state.candidate_erest,
                    )
                )
                short_motion_limit = (
                    self.config.degraded_mv_short_absent
                    if not piezo_ok
                    else self.config.mv_short_absent
                )
                short_quiet = (
                    mv10 is not None
                    and mv10 <= short_motion_limit
                )
                state.exit_confirm_run = (
                    state.exit_confirm_run + 1
                    if back and vitals_absent and short_quiet
                    else 0
                )
                required_exit_run = (
                    self.config.degraded_exit_confirm_run
                    if not piezo_ok
                    else self.config.exit_confirm_run
                )
                if state.exit_confirm_run >= required_exit_run:
                    state.state = EMPTY
                    event = "exit_step"
                    state.candidate_at = None
                    state.hold = 10
                elif timestamp - state.candidate_at > self.config.exit_confirm_window:
                    state.candidate_at = None

            unloaded_limit = (
                self.config.degraded_unloaded_absence_s
                if not piezo_ok
                else self.config.unloaded_absence_s
            )
            if (
                state.state == OCCUPIED
                and state.unloaded_quiet_run >= unloaded_limit
            ):
                state.state = EMPTY
                state.candidate_at = None
                event = "exit_absence"
            elif (
                state.state == OCCUPIED
                and piezo_ok
                and state.loaded_dead_run >= self.config.loaded_absence_s
            ):
                state.state = EMPTY
                state.candidate_at = None
                event = "exit_no_vitals"
            if state.state == EMPTY:
                state.life_run = 0
                state.unloaded_quiet_run = 0
                state.loaded_dead_run = 0

        return self._decision(
            side=side,
            timestamp=timestamp,
            event=event,
            piezo_ok=piezo_ok,
            load=load,
            mv60=mv60,
            e20_own=e20,
            e20_partner=e20_other,
        )

    def _decision(
        self,
        side: str,
        timestamp: float,
        event: Optional[str],
        piezo_ok: bool,
        load: Optional[float],
        mv60: Optional[float],
        e20_own: Optional[float],
        e20_partner: Optional[float],
    ) -> Decision:
        state = self._sides[side].state
        return Decision(
            side=side,
            timestamp=timestamp,
            state=state,
            occupied=state != EMPTY,
            confirmed=state == OCCUPIED,
            event=event,
            degraded=not piezo_ok,
            diagnostics={
                "load_above_reference": load,
                "mv60": mv60,
                "e20_own": e20_own,
                "e20_partner": e20_partner,
            },
        )

    def _energy_features(
        self,
        side: str,
        timestamp: float,
    ) -> Dict[str, Optional[float]]:
        energies = self._sides[side].energies
        return {
            "e5": _window_median(energies, timestamp - 5.0, timestamp, 3),
            "e20": _window_median(energies, timestamp - 20.0, timestamp, 10),
            "emax8": _window_max(energies, timestamp - 8.0, timestamp, 2),
            "erest": _window_percentile(
                energies,
                timestamp - 121.0,
                timestamp - 15.0,
                40,
                0.3,
            ),
        }

    def _prune_cap_history(self, state: _SideState, timestamp: float) -> None:
        state.cap_samples = [
            item for item in state.cap_samples
            if item[0] > timestamp - 61.0
        ]
        state.center_deltas = [
            item for item in state.center_deltas
            if item[0] > timestamp - 60.0
        ]

    def _prune_energy(self, state: _SideState, timestamp: float) -> None:
        cutoff_source = max(
            timestamp,
            self._last_cap_timestamp
            if self._last_cap_timestamp is not None
            else timestamp,
        )
        state.energies = [
            item for item in state.energies
            if item[0] > cutoff_source - 122.0
        ]

    def _snapshot_side(self, state: _SideState) -> dict:
        return {
            "state": state.state,
            "reference": list(state.reference) if state.reference is not None else None,
            "life_run": state.life_run,
            "unloaded_quiet_run": state.unloaded_quiet_run,
            "loaded_dead_run": state.loaded_dead_run,
            "boot_empty_run": state.boot_empty_run,
            "boot_life_run": state.boot_life_run,
            "provisional_since": state.provisional_since,
            "provisional_life": state.provisional_life,
            "candidate_at": state.candidate_at,
            "candidate_erest": state.candidate_erest,
            "candidate_prev_load": state.candidate_prev_load,
            "exit_confirm_run": state.exit_confirm_run,
            "hold": state.hold,
            "last_valid_cap": state.last_valid_cap,
            "cap_samples": [
                [timestamp, list(values)]
                for timestamp, values in state.cap_samples
            ],
            "center_deltas": [
                [timestamp, delta]
                for timestamp, delta in state.center_deltas
            ],
            "energies": [
                [timestamp, energy]
                for timestamp, energy in state.energies
            ],
            "piezo_zi": (
                _copy_filter_state(state.piezo_zi)
                if state.piezo_zi is not None
                else None
            ),
            "previous_piezo_second": state.previous_piezo_second,
        }

    def _restore_side(self, source: Mapping[str, object]) -> _SideState:
        state_name = source.get("state")
        if state_name not in (EMPTY, PROVISIONAL, OCCUPIED):
            raise ValueError("EoL occupancy checkpoint has invalid state")
        reference_raw = source.get("reference")
        reference = (
            _restore_channels(reference_raw, "reference")
            if reference_raw is not None
            else None
        )
        state = _SideState(
            state=str(state_name),
            reference=reference,
            life_run=_restore_nonnegative_int(source, "life_run"),
            unloaded_quiet_run=_restore_nonnegative_int(
                source,
                "unloaded_quiet_run",
            ),
            loaded_dead_run=_restore_nonnegative_int(source, "loaded_dead_run"),
            boot_empty_run=_restore_nonnegative_int(source, "boot_empty_run"),
            boot_life_run=_restore_nonnegative_int(source, "boot_life_run"),
            provisional_since=_optional_float(
                source.get("provisional_since"),
                "provisional_since",
            ),
            provisional_life=_restore_nonnegative_int(
                source,
                "provisional_life",
            ),
            candidate_at=_optional_float(source.get("candidate_at"), "candidate_at"),
            candidate_erest=_required_float(source, "candidate_erest"),
            candidate_prev_load=_optional_float(
                source.get("candidate_prev_load"),
                "candidate_prev_load",
            ),
            exit_confirm_run=_restore_nonnegative_int(
                source,
                "exit_confirm_run",
            ),
            hold=_restore_nonnegative_int(source, "hold"),
            last_valid_cap=_optional_float(
                source.get("last_valid_cap"),
                "last_valid_cap",
            ),
            cap_samples=_restore_cap_samples(source.get("cap_samples")),
            center_deltas=_restore_float_pairs(
                source.get("center_deltas"),
                "center_deltas",
            ),
            energies=_restore_float_pairs(source.get("energies"), "energies"),
            piezo_zi=_restore_filter_state(source.get("piezo_zi")),
            previous_piezo_second=_optional_float(
                source.get("previous_piezo_second"),
                "previous_piezo_second",
            ),
        )
        return state


def _block_means(samples: Sequence[float]) -> List[float]:
    return [
        math.fsum(samples[index:index + 20]) / 20.0
        for index in range(0, 500, 20)
    ]


def _same_frame(previous: Sequence[float], current: Sequence[float]) -> bool:
    return all(
        left == right
        or (math.isnan(left) and math.isnan(right))
        for left, right in zip(previous, current)
    )


def _restore_channels(value: object, name: str) -> _Channels:
    if not isinstance(value, Sequence) or len(value) != 3:
        raise ValueError("%s must contain three channels" % name)
    parsed = _channels(value)  # type: ignore[arg-type]
    if not all(math.isfinite(item) for item in parsed):
        raise ValueError("%s channels must be finite" % name)
    return parsed


def _restore_nonnegative_int(source: Mapping[str, object], name: str) -> int:
    value = source.get(name)
    if isinstance(value, bool):
        raise ValueError("%s must be a non-negative integer" % name)
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError("%s must be a non-negative integer" % name) from exc
    if parsed < 0 or parsed != value:
        raise ValueError("%s must be a non-negative integer" % name)
    return parsed


def _required_float(source: Mapping[str, object], name: str) -> float:
    value = _optional_float(source.get(name), name)
    if value is None:
        raise ValueError("%s is required" % name)
    return value


def _restore_cap_samples(value: object) -> List[Tuple[float, _Channels]]:
    if not isinstance(value, Sequence):
        raise ValueError("cap_samples must be a sequence")
    restored: List[Tuple[float, _Channels]] = []
    for item in value:
        if not isinstance(item, Sequence) or len(item) != 2:
            raise ValueError("cap_samples entries must be timestamp/value pairs")
        timestamp = _optional_float(item[0], "cap_samples timestamp")
        if timestamp is None:
            raise ValueError("cap_samples timestamp is required")
        restored.append((timestamp, _restore_channels(item[1], "cap_samples value")))
    _validate_ordered(restored, "cap_samples")
    return restored


def _restore_float_pairs(value: object, name: str) -> List[Tuple[float, float]]:
    if not isinstance(value, Sequence):
        raise ValueError("%s must be a sequence" % name)
    restored: List[Tuple[float, float]] = []
    for item in value:
        if not isinstance(item, Sequence) or len(item) != 2:
            raise ValueError("%s entries must be pairs" % name)
        timestamp = _optional_float(item[0], "%s timestamp" % name)
        number = _optional_float(item[1], "%s value" % name)
        if timestamp is None or number is None:
            raise ValueError("%s entries must be finite" % name)
        restored.append((timestamp, number))
    _validate_ordered(restored, name)
    return restored


def _validate_ordered(values: Sequence[Tuple[float, object]], name: str) -> None:
    if any(
        values[index][0] < values[index - 1][0]
        for index in range(1, len(values))
    ):
        raise ValueError("%s timestamps must be ordered" % name)


def _restore_filter_state(value: object) -> Optional[_FilterState]:
    if value is None:
        return None
    if not isinstance(value, Sequence) or len(value) != len(SOS_MOTION):
        raise ValueError("piezo_zi must have one state per SOS section")
    restored: _FilterState = []
    for row in value:
        if not isinstance(row, Sequence) or len(row) != 2:
            raise ValueError("piezo_zi sections must have two values")
        first = _optional_float(row[0], "piezo_zi")
        second = _optional_float(row[1], "piezo_zi")
        if first is None or second is None:
            raise ValueError("piezo_zi values are required")
        restored.append([first, second])
    return restored
