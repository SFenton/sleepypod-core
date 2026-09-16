#!/usr/bin/env python3
"""Continuous adaptive occupancy runtime."""

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
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional, Sequence, Tuple

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.adaptive_occupancy import (
    ALGORITHM_VERSION,
    AdaptiveCapPair,
    Channels,
    Decision,
)


BIOMETRICS_DB = Path(
    os.environ.get(
        "BIOMETRICS_DATABASE_URL",
        "file:/persistent/sleepypod-data/biometrics.db",
    ).replace("file:", "")
)
CHECKPOINT_PATH = Path(
    os.environ.get(
        "ADAPTIVE_OCCUPANCY_CHECKPOINT",
        "/persistent/sleepypod-data/adaptive-occupancy-checkpoint.json",
    )
)
POLL_SECONDS = float(os.environ.get("ADAPTIVE_OCCUPANCY_POLL_SECONDS", "5"))
FETCH_LIMIT = 2000

log = logging.getLogger("adaptive-occupancy")
_shutdown = threading.Event()


def _on_signal(signum, _frame):
    log.info("Received signal %d, shutting down", signum)
    _shutdown.set()


def open_database(path: Path = BIOMETRICS_DB) -> sqlite3.Connection:
    connection = sqlite3.connect(str(path), timeout=5.0)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=NORMAL")
    ensure_state_table(connection)
    return connection


def ensure_state_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS adaptive_occupancy_state (
               side TEXT PRIMARY KEY NOT NULL,
               sample_timestamp INTEGER NOT NULL,
               load_present INTEGER NOT NULL,
               classification TEXT NOT NULL,
               person_present INTEGER,
               score REAL NOT NULL,
               peak_score REAL NOT NULL,
               loaded_channels INTEGER NOT NULL,
               load_velocity_score REAL NOT NULL,
               unload_velocity_score REAL NOT NULL,
               entry_velocity_supported INTEGER NOT NULL,
               reason TEXT NOT NULL,
               baseline TEXT NOT NULL,
               last_transition_at INTEGER,
               algorithm_version TEXT NOT NULL,
               updated_at INTEGER NOT NULL
           )"""
    )
    connection.commit()


def _parse_timestamp(value: str) -> float:
    try:
        timestamp = float(value)
    except ValueError:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        timestamp = parsed.timestamp()
    if not math.isfinite(timestamp):
        raise ValueError("timestamp must be finite")
    return timestamp


def baseline_window_from_environment() -> Tuple[float, float]:
    start = os.environ.get("ADAPTIVE_OCCUPANCY_BASELINE_FROM")
    end = os.environ.get("ADAPTIVE_OCCUPANCY_BASELINE_TO")
    if not start or not end:
        raise RuntimeError(
            "No adaptive occupancy checkpoint exists and "
            "ADAPTIVE_OCCUPANCY_BASELINE_FROM/TO are not configured"
        )
    start_ts = _parse_timestamp(start)
    end_ts = _parse_timestamp(end)
    if start_ts >= end_ts:
        raise ValueError("adaptive occupancy baseline window must be increasing")
    return start_ts, end_ts


def _decode_channels(encoded: str) -> Channels:
    values = json.loads(encoded)
    if not isinstance(values, list) or len(values) != 3:
        raise ValueError("cap_sense_frames.zones must contain three values")
    channels = tuple(float(value) for value in values)
    if not all(math.isfinite(value) for value in channels):
        raise ValueError("cap_sense_frames.zones must contain finite values")
    return channels  # type: ignore[return-value]


def read_baseline_samples(
    connection: sqlite3.Connection,
    start: float,
    end: float,
) -> Dict[str, list[Channels]]:
    samples: Dict[str, list[Channels]] = {"left": [], "right": []}
    rows = connection.execute(
        """SELECT side, zones
             FROM cap_sense_frames
            WHERE timestamp >= ? AND timestamp < ? AND zones IS NOT NULL
            ORDER BY timestamp, side""",
        (int(start), int(end)),
    )
    for side, encoded in rows:
        if side in samples:
            samples[side].append(_decode_channels(encoded))
    for side in ("left", "right"):
        if len(samples[side]) < 3:
            raise RuntimeError(
                f"baseline window has only {len(samples[side])} {side} samples"
            )
    return samples


def fetch_complete_pairs(
    connection: sqlite3.Connection,
    after_timestamp: int,
) -> Tuple[list[Tuple[int, Channels, Channels]], int]:
    rows = connection.execute(
        """SELECT side, timestamp, zones
             FROM cap_sense_frames
            WHERE timestamp > ? AND zones IS NOT NULL
            ORDER BY timestamp, side
            LIMIT ?""",
        (after_timestamp, FETCH_LIMIT),
    ).fetchall()
    if not rows:
        return [], after_timestamp

    grouped: Dict[int, Dict[str, Channels]] = {}
    for side, timestamp, encoded in rows:
        if side in ("left", "right"):
            grouped.setdefault(int(timestamp), {})[side] = _decode_channels(encoded)

    timestamps = sorted(grouped)
    if len(rows) == FETCH_LIMIT or len(grouped[timestamps[-1]]) < 2:
        timestamps = timestamps[:-1]
    pairs = []
    cursor = after_timestamp
    for timestamp in timestamps:
        sides = grouped[timestamp]
        cursor = timestamp
        if "left" in sides and "right" in sides:
            pairs.append((timestamp, sides["left"], sides["right"]))
        else:
            log.warning("Skipping unpaired capSense timestamp %d", timestamp)
    return pairs, cursor


def write_state(
    connection: sqlite3.Connection,
    decisions: Mapping[str, Decision],
) -> None:
    updated_at = int(time.time())
    with connection:
        for side in ("left", "right"):
            decision = decisions[side]
            connection.execute(
                """INSERT INTO adaptive_occupancy_state (
                       side, sample_timestamp, load_present, classification,
                       person_present, score, peak_score, loaded_channels,
                       load_velocity_score, unload_velocity_score,
                       entry_velocity_supported, reason, baseline,
                       last_transition_at, algorithm_version, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(side) DO UPDATE SET
                       sample_timestamp = excluded.sample_timestamp,
                       load_present = excluded.load_present,
                       classification = excluded.classification,
                       person_present = excluded.person_present,
                       score = excluded.score,
                       peak_score = excluded.peak_score,
                       loaded_channels = excluded.loaded_channels,
                       load_velocity_score = excluded.load_velocity_score,
                       unload_velocity_score = excluded.unload_velocity_score,
                       entry_velocity_supported = excluded.entry_velocity_supported,
                       reason = excluded.reason,
                       baseline = excluded.baseline,
                       last_transition_at = COALESCE(
                           excluded.last_transition_at,
                           adaptive_occupancy_state.last_transition_at
                       ),
                       algorithm_version = excluded.algorithm_version,
                       updated_at = excluded.updated_at""",
                (
                    side,
                    int(decision.timestamp),
                    int(decision.occupied),
                    decision.classification,
                    (
                        None
                        if decision.person_present is None
                        else int(decision.person_present)
                    ),
                    decision.score,
                    decision.peak_score,
                    decision.loaded_channels,
                    decision.load_velocity_score,
                    decision.unload_velocity_score,
                    int(decision.entry_velocity_supported),
                    decision.reason,
                    json.dumps(list(decision.baseline)),
                    (
                        int(decision.edge_timestamp)
                        if decision.edge_timestamp is not None
                        else None
                    ),
                    ALGORITHM_VERSION,
                    updated_at,
                ),
            )


def save_checkpoint(
    path: Path,
    detector: AdaptiveCapPair,
    cursor_timestamp: int,
) -> None:
    payload = detector.snapshot()
    payload["cursor_timestamp"] = cursor_timestamp
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as handle:
        json.dump(payload, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, path)


def load_checkpoint(path: Path) -> Tuple[AdaptiveCapPair, int]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("adaptive occupancy checkpoint is malformed")
    cursor = int(payload["cursor_timestamp"])
    return AdaptiveCapPair.from_snapshot(payload), cursor


def process_available(
    connection: sqlite3.Connection,
    detector: AdaptiveCapPair,
    cursor_timestamp: int,
) -> Tuple[int, Optional[Dict[str, Decision]]]:
    latest = None
    last_transition = {"left": None, "right": None}
    while True:
        pairs, cursor = fetch_complete_pairs(connection, cursor_timestamp)
        for timestamp, left, right in pairs:
            latest = detector.update(timestamp, left, right)
            for side, decision in latest.items():
                if decision.edge_timestamp is not None:
                    last_transition[side] = decision.edge_timestamp
        if cursor == cursor_timestamp:
            break
        cursor_timestamp = cursor
        if len(pairs) < FETCH_LIMIT // 2:
            break
    if latest is not None:
        latest = {
            side: (
                replace(decision, edge_timestamp=last_transition[side])
                if last_transition[side] is not None
                else decision
            )
            for side, decision in latest.items()
        }
    return cursor_timestamp, latest


def bootstrap_detector(
    connection: sqlite3.Connection,
    baseline_start: float,
    baseline_end: float,
) -> Tuple[AdaptiveCapPair, int, Dict[str, Decision]]:
    samples = read_baseline_samples(connection, baseline_start, baseline_end)
    detector = AdaptiveCapPair(samples["left"], samples["right"])
    cursor, decisions = process_available(
        connection,
        detector,
        int(baseline_end) - 1,
    )
    if decisions is None:
        timestamp = int(baseline_end)
        decisions = detector.update(
            timestamp,
            samples["left"][-1],
            samples["right"][-1],
        )
        cursor = timestamp
    return detector, cursor, decisions


def run() -> None:
    connection = open_database()
    try:
        if CHECKPOINT_PATH.exists():
            detector, cursor = load_checkpoint(CHECKPOINT_PATH)
            log.info("Restored checkpoint at %d", cursor)
            cursor, decisions = process_available(connection, detector, cursor)
        else:
            baseline_start, baseline_end = baseline_window_from_environment()
            detector, cursor, decisions = bootstrap_detector(
                connection,
                baseline_start,
                baseline_end,
            )
            log.info(
                "Bootstrapped from explicit empty window %.0f-%.0f",
                baseline_start,
                baseline_end,
            )

        if decisions is not None:
            write_state(connection, decisions)
        save_checkpoint(CHECKPOINT_PATH, detector, cursor)

        while not _shutdown.wait(POLL_SECONDS):
            try:
                next_cursor, decisions = process_available(
                    connection,
                    detector,
                    cursor,
                )
                if next_cursor == cursor:
                    continue
                cursor = next_cursor
                if decisions is not None:
                    write_state(connection, decisions)
                save_checkpoint(CHECKPOINT_PATH, detector, cursor)
            except sqlite3.OperationalError as error:
                log.warning("Biometrics database temporarily unavailable: %s", error)
    finally:
        connection.close()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("run",), nargs="?", default="run")
    parser.parse_args(argv)
    run()
    return 0


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [adaptive-occupancy] %(levelname)s %(message)s",
    )
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    raise SystemExit(main())
