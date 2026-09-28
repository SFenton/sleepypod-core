#!/usr/bin/env python3
"""Continuous evidence-of-life (EoL) occupancy runtime.

Follows the raw capSense and piezo streams (NATS on new firmware, ``*.RAW``
files otherwise), runs :class:`common.eol_occupancy.EolPair`, and keeps one
``eol_occupancy_state`` row per side in biometrics.db for the MQTT bridge.
"""

import argparse
import json
import logging
import math
import os
import signal
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Dict, Mapping, Optional, Sequence, Tuple

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.eol_occupancy import (  # noqa: E402
    ALGORITHM_VERSION,
    PROVISIONAL,
    SIDES,
    Decision,
    EolPair,
)
from common.eol_replay import capsense_side, int32_samples  # noqa: E402


BIOMETRICS_DB = Path(
    os.environ.get(
        "BIOMETRICS_DATABASE_URL",
        "file:/persistent/sleepypod-data/biometrics.db",
    ).replace("file:", "")
)
CHECKPOINT_PATH = Path(
    os.environ.get(
        "EOL_OCCUPANCY_CHECKPOINT",
        "/persistent/sleepypod-data/eol-occupancy-checkpoint.json",
    )
)
RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent/biometrics"))
HEARTBEAT_SECONDS = float(os.environ.get("EOL_OCCUPANCY_HEARTBEAT_SECONDS", "5"))
CHECKPOINT_SECONDS = float(os.environ.get("EOL_OCCUPANCY_CHECKPOINT_SECONDS", "60"))
SUMMARY_SECONDS = 600.0
CHECKPOINT_VERSION = 1
# A backward wall-clock step larger than this rebases the rolling windows
# instead of clamping every later sample onto one instant.
CLOCK_REBASE_SECONDS = 60.0
SUBJECTS = ("raw.sens.capsense", "raw.sens.piezo")
PIEZO_SAMPLES = 500

log = logging.getLogger("eol-occupancy")
_shutdown = threading.Event()


def _on_signal(signum, _frame):
    log.info("Received signal %d, shutting down", signum)
    _shutdown.set()


def open_database(path: Path = BIOMETRICS_DB) -> sqlite3.Connection:
    # The app's drizzle migration owns eol_occupancy_state. Modules start before
    # the app during sp-update, so creating the table here would make that
    # migration fail; writes simply retry until the table exists.
    connection = sqlite3.connect(str(path), timeout=5.0)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=NORMAL")
    return connection


def _optional_int(value: Optional[float]) -> Optional[int]:
    return None if value is None else int(value)


def _optional_real(value: Optional[float]) -> Optional[float]:
    return value if value is not None and math.isfinite(value) else None


class Runtime:
    """Feeds decoded raw records to the detector and tracks per-side history."""

    def __init__(self, pair: Optional[EolPair] = None,
                 history: Optional[Mapping[str, Mapping[str, object]]] = None):
        self.pair = pair or EolPair()
        self.history: Dict[str, Dict[str, object]] = {
            side: {"state_since": None, "last_event": None, "last_event_at": None}
            for side in SIDES
        }
        for side in SIDES:
            if history and isinstance(history.get(side), Mapping):
                for key in self.history[side]:
                    self.history[side][key] = history[side].get(key)
        snapshot = self.pair.snapshot()
        self.states: Dict[str, str] = {
            side: snapshot["sides"][side]["state"] for side in SIDES
        }
        stamps = [snapshot.get("last_cap_timestamp")]
        stamps += [
            snapshot["sides"][side].get("previous_piezo_second")
            for side in SIDES
        ]
        known = [float(stamp) for stamp in stamps if stamp is not None]
        self.last_timestamp: Optional[float] = max(known) if known else None
        self.skipped: Dict[str, int] = {}

    def clock(self, received_at: float) -> float:
        """Map wall-clock receipt time onto a strictly increasing timeline."""

        if (
            self.last_timestamp is not None
            and received_at < self.last_timestamp - CLOCK_REBASE_SECONDS
        ):
            log.warning(
                "Wall clock stepped back %.0fs; rebasing EoL rolling windows",
                self.last_timestamp - received_at,
            )
            self.pair = rebase_pair(self.pair, received_at)
            self.last_timestamp = None
        timestamp = received_at
        if self.last_timestamp is not None and timestamp <= self.last_timestamp:
            timestamp = self.last_timestamp + 0.001
        self.last_timestamp = timestamp
        return timestamp

    def handle_record(
        self,
        record: Mapping[str, object],
        received_at: float,
    ) -> Optional[Dict[str, Decision]]:
        record_type = record.get("type")
        try:
            if record_type == "piezo-dual":
                left = int32_samples(record.get("left1"), "left1")
                right = int32_samples(record.get("right1"), "right1")
                if len(left) != PIEZO_SAMPLES or len(right) != PIEZO_SAMPLES:
                    self._skip("piezo_sample_count")
                    return None
                # Resolve the clock first: a rebase replaces self.pair.
                timestamp = self.clock(received_at)
                self.pair.update_piezo_raw(timestamp, left, right)
                return None
            if record_type == "capSense":
                left, left_good = capsense_side(record, "left")
                right, right_good = capsense_side(record, "right")
                timestamp = self.clock(received_at)
                decisions = self.pair.update_cap(
                    timestamp,
                    left,
                    right,
                    left_good=left_good,
                    right_good=right_good,
                )
                if decisions is not None:
                    self._track(decisions)
                return decisions
        except ValueError as error:
            self._skip("malformed_%s" % record_type, error)
        return None

    def _skip(self, reason: str, error: Optional[Exception] = None) -> None:
        count = self.skipped.get(reason, 0) + 1
        self.skipped[reason] = count
        if count == 1:
            log.warning("Skipping raw record (%s)%s", reason,
                        ": %s" % error if error is not None else "")

    def _track(self, decisions: Mapping[str, Decision]) -> None:
        for side, decision in decisions.items():
            history = self.history[side]
            if decision.event is not None:
                history["last_event"] = decision.event
                history["last_event_at"] = decision.timestamp
            if self.states[side] != decision.state or history["state_since"] is None:
                history["state_since"] = decision.timestamp
            self.states[side] = decision.state

    def checkpoint_payload(self) -> dict:
        return {
            "checkpoint_version": CHECKPOINT_VERSION,
            "detector": self.pair.snapshot(),
            "history": {side: dict(self.history[side]) for side in SIDES},
            "saved_at": time.time(),
        }


def rebase_pair(pair: EolPair, timestamp: float) -> EolPair:
    """Keep each side's state and empty reference; drop time-keyed evidence."""

    snapshot = pair.snapshot()
    snapshot["last_cap_timestamp"] = None
    snapshot["last_frame_values"] = None
    for side in SIDES:
        source = snapshot["sides"][side]
        snapshot["sides"][side] = {
            "state": source["state"],
            "reference": source["reference"],
            "life_run": 0,
            "unloaded_quiet_run": 0,
            "loaded_dead_run": 0,
            "boot_empty_run": 0,
            "boot_life_run": 0,
            "provisional_since": (
                timestamp if source["state"] == PROVISIONAL else None
            ),
            "provisional_life": 0,
            "candidate_at": None,
            "candidate_erest": 0.0,
            "candidate_prev_load": None,
            "exit_confirm_run": 0,
            "hold": 0,
            "last_valid_cap": None,
            "cap_samples": [],
            "center_deltas": [],
            "energies": [],
            "piezo_zi": None,
            "previous_piezo_second": None,
        }
    return EolPair.from_snapshot(snapshot)


def save_checkpoint(path: Path, runtime: Runtime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as handle:
        json.dump(runtime.checkpoint_payload(), handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, path)


def load_checkpoint(path: Path) -> Runtime:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(payload, Mapping)
        or payload.get("checkpoint_version") != CHECKPOINT_VERSION
        or not isinstance(payload.get("detector"), Mapping)
    ):
        raise ValueError("EoL occupancy checkpoint is malformed")
    history = payload.get("history")
    return Runtime(
        EolPair.from_snapshot(payload["detector"]),
        history if isinstance(history, Mapping) else None,
    )


def restore_runtime(path: Path = CHECKPOINT_PATH) -> Runtime:
    if path.exists():
        try:
            runtime = load_checkpoint(path)
            log.info("Restored checkpoint (last sample %s)", runtime.last_timestamp)
            return runtime
        except (OSError, ValueError, KeyError, TypeError) as error:
            log.warning("Ignoring unusable checkpoint %s: %s", path, error)
    log.info("Starting without a checkpoint; the empty reference will bootstrap")
    return Runtime()


def write_state(
    connection: sqlite3.Connection,
    decisions: Mapping[str, Decision],
    runtime: Runtime,
) -> None:
    updated_at = int(time.time())
    with connection:
        for side in SIDES:
            decision = decisions[side]
            history = runtime.history[side]
            diagnostics = decision.diagnostics
            connection.execute(
                """INSERT INTO eol_occupancy_state (
                       side, sample_timestamp, state, occupied, confirmed,
                       degraded, state_since, last_event, last_event_at,
                       load_above_reference, mv60, e20_own, e20_partner,
                       algorithm_version, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(side) DO UPDATE SET
                       sample_timestamp = excluded.sample_timestamp,
                       state = excluded.state,
                       occupied = excluded.occupied,
                       confirmed = excluded.confirmed,
                       degraded = excluded.degraded,
                       state_since = excluded.state_since,
                       last_event = excluded.last_event,
                       last_event_at = excluded.last_event_at,
                       load_above_reference = excluded.load_above_reference,
                       mv60 = excluded.mv60,
                       e20_own = excluded.e20_own,
                       e20_partner = excluded.e20_partner,
                       algorithm_version = excluded.algorithm_version,
                       updated_at = excluded.updated_at""",
                (
                    side,
                    int(decision.timestamp),
                    decision.state,
                    int(decision.occupied),
                    int(decision.confirmed),
                    int(decision.degraded),
                    _optional_int(history["state_since"]),  # type: ignore[arg-type]
                    history["last_event"],
                    _optional_int(history["last_event_at"]),  # type: ignore[arg-type]
                    _optional_real(diagnostics.get("load_above_reference")),
                    _optional_real(diagnostics.get("mv60")),
                    _optional_real(diagnostics.get("e20_own")),
                    _optional_real(diagnostics.get("e20_partner")),
                    ALGORITHM_VERSION,
                    updated_at,
                ),
            )


def _signature(decisions: Mapping[str, Decision]) -> Tuple[Tuple[str, bool], ...]:
    return tuple((decisions[side].state, decisions[side].degraded) for side in SIDES)


def run(follower, connection: sqlite3.Connection, runtime: Runtime,
        checkpoint_path: Path = CHECKPOINT_PATH,
        now=time.time) -> None:
    last_signature = None
    last_write = last_checkpoint = last_summary = now()
    for record in follower.read_records():
        if not isinstance(record, Mapping):
            continue
        received_at = now()
        decisions = runtime.handle_record(record, received_at)
        if decisions is None:
            continue
        signature = _signature(decisions)
        changed = signature != last_signature or any(
            decision.event is not None for decision in decisions.values()
        )
        if changed:
            for side in SIDES:
                if decisions[side].event is not None:
                    log.info(
                        "%s %s -> %s%s",
                        side,
                        decisions[side].event,
                        decisions[side].state,
                        " (degraded)" if decisions[side].degraded else "",
                    )
        if changed or received_at - last_write >= HEARTBEAT_SECONDS:
            try:
                write_state(connection, decisions, runtime)
                last_write = received_at
                last_signature = signature
            except sqlite3.OperationalError as error:
                log.warning("Biometrics database temporarily unavailable: %s", error)
        if changed or received_at - last_checkpoint >= CHECKPOINT_SECONDS:
            try:
                save_checkpoint(checkpoint_path, runtime)
                last_checkpoint = received_at
            except OSError as error:
                log.warning("Could not save checkpoint: %s", error)
        if received_at - last_summary >= SUMMARY_SECONDS:
            last_summary = received_at
            log.info(
                "left=%s right=%s degraded=%s skipped=%s",
                decisions["left"].state,
                decisions["right"].state,
                decisions["left"].degraded,
                runtime.skipped or {},
            )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("run",), nargs="?", default="run")
    parser.parse_args(argv)

    from common.nats_follower import create_follower

    runtime = restore_runtime()
    connection = open_database()
    follower = create_follower(
        RAW_DATA_DIR,
        _shutdown,
        poll_interval=0.01,
        subjects=SUBJECTS,
    )
    log.info("Starting %s", ALGORITHM_VERSION)
    try:
        run(follower, connection, runtime)
    finally:
        try:
            save_checkpoint(CHECKPOINT_PATH, runtime)
        except OSError as error:
            log.warning("Could not save final checkpoint: %s", error)
        connection.close()
    return 0


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [eol-occupancy] %(levelname)s %(message)s",
    )
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    raise SystemExit(main())
