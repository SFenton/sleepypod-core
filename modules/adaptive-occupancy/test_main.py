import importlib.util
import json
import sqlite3
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("main.py")
SPEC = importlib.util.spec_from_file_location("adaptive_occupancy_runtime", MODULE_PATH)
runtime = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runtime)


def _database():
    connection = sqlite3.connect(":memory:")
    connection.execute(
        """CREATE TABLE cap_sense_frames (
               side TEXT NOT NULL,
               timestamp INTEGER NOT NULL,
               zones TEXT
           )"""
    )
    runtime.ensure_state_table(connection)
    return connection


def _insert_pair(connection, timestamp, left, right):
    connection.executemany(
        "INSERT INTO cap_sense_frames (side, timestamp, zones) VALUES (?, ?, ?)",
        [
            ("left", timestamp, json.dumps(left)),
            ("right", timestamp, json.dumps(right)),
        ],
    )


def test_bootstrap_replays_to_current_state():
    connection = _database()
    for timestamp in range(100, 130, 5):
        _insert_pair(connection, timestamp, [1400, 1100, 1250], [1700, 1550, 2290])
    for timestamp in range(130, 150, 5):
        _insert_pair(connection, timestamp, [1800, 1500, 1550], [1700, 1550, 2290])

    detector, cursor, decisions = runtime.bootstrap_detector(connection, 100, 130)

    assert cursor == 145
    assert decisions["left"].occupied is True
    assert decisions["right"].occupied is False
    assert detector.sides["left"].occupied is True


def test_checkpoint_round_trip_preserves_detector_state(tmp_path):
    connection = _database()
    for timestamp in range(100, 130, 5):
        _insert_pair(connection, timestamp, [1400, 1100, 1250], [1700, 1550, 2290])
    for timestamp in range(130, 150, 5):
        _insert_pair(connection, timestamp, [1800, 1500, 1550], [1700, 1550, 2290])
    detector, cursor, _ = runtime.bootstrap_detector(connection, 100, 130)

    checkpoint = tmp_path / "checkpoint.json"
    runtime.save_checkpoint(checkpoint, detector, cursor)
    restored, restored_cursor = runtime.load_checkpoint(checkpoint)

    assert restored_cursor == cursor
    assert restored.snapshot() == detector.snapshot()


def test_v1_checkpoint_restores_with_v2_defaults():
    connection = _database()
    for timestamp in range(100, 130, 5):
        _insert_pair(connection, timestamp, [1400, 1100, 1250], [1700, 1550, 2290])
    detector, _, _ = runtime.bootstrap_detector(connection, 100, 125)
    payload = detector.snapshot()
    payload["algorithm_version"] = "adaptive-cap-v1"
    for side in ("left", "right"):
        del payload["sides"][side]["weak_single_channel_since"]

    restored = runtime.AdaptiveCapPair.from_snapshot(payload)

    assert restored.snapshot()["algorithm_version"] == "adaptive-cap-v3"
    assert restored.sides["left"]._weak_single_channel_since is None
    assert restored.sides["right"]._weak_single_channel_since is None


def test_state_upsert_retains_last_transition():
    connection = _database()
    for timestamp in range(100, 130, 5):
        _insert_pair(connection, timestamp, [1400, 1100, 1250], [1700, 1550, 2290])
    for timestamp in range(130, 155, 5):
        _insert_pair(connection, timestamp, [1800, 1500, 1550], [1700, 1550, 2290])
    detector, _, decisions = runtime.bootstrap_detector(connection, 100, 130)
    runtime.write_state(connection, decisions)

    held = detector.update(160, [1800, 1500, 1550], [1700, 1550, 2290])
    runtime.write_state(connection, held)
    row = connection.execute(
        """SELECT load_present, classification, last_transition_at
             FROM adaptive_occupancy_state WHERE side = 'left'"""
    ).fetchone()

    assert row == (1, "loaded_unconfirmed", 130)
