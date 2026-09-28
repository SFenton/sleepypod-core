import importlib.util
import json
import sqlite3
import struct
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).with_name("main.py")
SPEC = importlib.util.spec_from_file_location("eol_occupancy_runtime", MODULE_PATH)
runtime_module = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runtime_module)

from common.eol_occupancy import Decision, EolPair  # noqa: E402

EMPTY_LEFT = (1400.0, 1100.0, 1250.0)
EMPTY_RIGHT = (1700.0, 1550.0, 2290.0)


def _cap(left, right, status="good"):
    return {
        "type": "capSense",
        "left": {"out": left[0], "cen": left[1], "in": left[2], "status": status},
        "right": {"out": right[0], "cen": right[1], "in": right[2], "status": "good"},
    }


def _piezo(value=0, count=500):
    samples = struct.pack("<%di" % count, *([value] * count))
    return {"type": "piezo-dual", "left1": samples, "right1": samples}


def _quiet_bed_records(seconds, start=1000.0):
    """One piezo second and one capSense frame per second of a still, empty bed."""
    for index in range(seconds):
        jitter = float(index % 2)
        yield start + index, _piezo(index % 3)
        yield start + index + 0.5, _cap(
            (EMPTY_LEFT[0], EMPTY_LEFT[1] + jitter, EMPTY_LEFT[2]),
            (EMPTY_RIGHT[0], EMPTY_RIGHT[1] + jitter, EMPTY_RIGHT[2]),
        )


MIGRATION = Path(__file__).resolve().parents[2] / "src/db/biometrics-migrations/0017_tiny_exodus.sql"


def _database():
    connection = sqlite3.connect(":memory:")
    connection.executescript(MIGRATION.read_text(encoding="utf-8"))
    return connection


def _rows(connection):
    cursor = connection.execute("SELECT * FROM eol_occupancy_state ORDER BY side")
    names = [column[0] for column in cursor.description]
    return {row[0]: dict(zip(names, row)) for row in cursor.fetchall()}


def _decision(side, timestamp, state, event=None, degraded=False):
    return Decision(
        side=side,
        timestamp=timestamp,
        state=state,
        occupied=state != "empty",
        confirmed=state == "occupied",
        event=event,
        degraded=degraded,
        diagnostics={
            "load_above_reference": 12.5,
            "mv60": 3.0,
            "e20_own": 1000.0,
            "e20_partner": float("nan"),
        },
    )


class FakeFollower:
    def __init__(self, records):
        self.records = list(records)

    def read_records(self):
        for _timestamp, record in self.records:
            yield record


def _fake_clock(records):
    times = iter([records[0][0]] + [timestamp for timestamp, _record in records])
    return lambda: next(times)


def test_capsense_frames_evaluate_and_duplicates_are_ignored():
    runtime = runtime_module.Runtime()
    runtime.handle_record(_piezo(), 100.0)
    first = runtime.handle_record(_cap(EMPTY_LEFT, EMPTY_RIGHT), 100.2)
    duplicate = runtime.handle_record(_cap(EMPTY_LEFT, EMPTY_RIGHT), 100.3)

    assert first["left"].state == "empty"
    assert first["right"].timestamp == 100.2
    assert duplicate is None


def test_bad_capsense_status_marks_side_unevaluated_but_keeps_other_side():
    runtime = runtime_module.Runtime()
    decisions = runtime.handle_record(_cap(EMPTY_LEFT, EMPTY_RIGHT, status="bad"), 10.0)

    assert decisions["left"].diagnostics["load_above_reference"] is None
    assert decisions["right"].state == "empty"


def test_malformed_and_short_records_are_counted_not_raised():
    runtime = runtime_module.Runtime()

    assert runtime.handle_record(_piezo(count=499), 1.0) is None
    assert runtime.handle_record({"type": "capSense", "left": {}}, 2.0) is None
    assert runtime.handle_record({"type": "piezo-dual", "left1": "nope"}, 3.0) is None
    assert runtime.handle_record({"type": "frzHealth"}, 4.0) is None

    assert runtime.skipped == {
        "piezo_sample_count": 1,
        "malformed_capSense": 1,
        "malformed_piezo-dual": 1,
    }


def test_clock_is_strictly_increasing_for_small_backward_jitter():
    runtime = runtime_module.Runtime()

    assert runtime.clock(100.0) == 100.0
    assert runtime.clock(99.5) == pytest.approx(100.001)
    assert runtime.clock(100.0005) == pytest.approx(100.002)
    assert runtime.clock(101.0) == 101.0


def test_large_backward_clock_step_rebases_windows_but_keeps_state_and_reference():
    runtime = runtime_module.Runtime()
    for timestamp, record in _quiet_bed_records(120):
        runtime.handle_record(record, timestamp)
    snapshot = runtime.pair.snapshot()["sides"]["left"]
    assert snapshot["reference"] is not None

    decisions = None
    for timestamp, record in _quiet_bed_records(3, start=500.0):
        decisions = runtime.handle_record(record, timestamp)

    rebased = runtime.pair.snapshot()["sides"]["left"]
    assert decisions["left"].state == "empty"
    assert rebased["reference"] == pytest.approx(snapshot["reference"], abs=0.1)
    assert len(rebased["cap_samples"]) == 3
    assert len(rebased["energies"]) == 3
    assert runtime.skipped == {}
    assert runtime.last_timestamp < 510.0


def test_rebase_restarts_a_provisional_timeout_at_the_new_time():
    pair = EolPair()
    snapshot = pair.snapshot()
    snapshot["sides"]["left"]["state"] = "provisional"
    snapshot["sides"]["left"]["provisional_since"] = 5000.0
    snapshot["sides"]["left"]["reference"] = list(EMPTY_LEFT)

    rebased = runtime_module.rebase_pair(EolPair.from_snapshot(snapshot), 42.0)

    left = rebased.snapshot()["sides"]["left"]
    assert left["state"] == "provisional"
    assert left["provisional_since"] == 42.0
    assert left["reference"] == list(EMPTY_LEFT)


def test_history_tracks_state_since_and_last_event():
    runtime = runtime_module.Runtime()
    runtime._track({"left": _decision("left", 10.0, "empty"), "right": _decision("right", 10.0, "empty")})
    runtime._track({"left": _decision("left", 11.0, "provisional", "entry_step"),
                    "right": _decision("right", 11.0, "empty")})
    runtime._track({"left": _decision("left", 12.0, "provisional"),
                    "right": _decision("right", 12.0, "empty")})

    assert runtime.history["left"] == {
        "state_since": 11.0,
        "last_event": "entry_step",
        "last_event_at": 11.0,
    }
    assert runtime.history["right"]["state_since"] == 10.0
    assert runtime.history["right"]["last_event"] is None


def test_write_state_upserts_both_sides_with_nullable_diagnostics():
    connection = _database()
    runtime = runtime_module.Runtime()
    decisions = {
        "left": _decision("left", 20.7, "occupied", "entry_confirmed"),
        "right": _decision("right", 20.7, "empty", degraded=True),
    }
    runtime._track(decisions)

    runtime_module.write_state(connection, decisions, runtime)
    runtime_module.write_state(connection, decisions, runtime)

    rows = _rows(connection)
    assert set(rows) == {"left", "right"}
    assert rows["left"]["sample_timestamp"] == 20
    assert rows["left"]["state"] == "occupied"
    assert rows["left"]["occupied"] == 1
    assert rows["left"]["confirmed"] == 1
    assert rows["left"]["last_event"] == "entry_confirmed"
    assert rows["left"]["last_event_at"] == 20
    assert rows["left"]["load_above_reference"] == 12.5
    assert rows["left"]["e20_partner"] is None
    assert rows["right"]["degraded"] == 1
    assert rows["right"]["confirmed"] == 0
    assert rows["right"]["algorithm_version"] == "eol-occupancy-v4"


def test_checkpoint_round_trip_preserves_detector_and_history(tmp_path):
    runtime = runtime_module.Runtime()
    for timestamp, record in _quiet_bed_records(120):
        runtime.handle_record(record, timestamp)
    path = tmp_path / "checkpoint.json"

    runtime_module.save_checkpoint(path, runtime)
    restored = runtime_module.load_checkpoint(path)

    assert restored.pair.snapshot() == runtime.pair.snapshot()
    assert restored.history == runtime.history
    assert restored.states == runtime.states
    assert restored.last_timestamp == runtime.last_timestamp
    assert not list(tmp_path.glob(".checkpoint.json.*"))


def test_restore_runtime_falls_back_when_checkpoint_is_unusable(tmp_path):
    path = tmp_path / "checkpoint.json"
    path.write_text(json.dumps({"checkpoint_version": 99}), encoding="utf-8")

    runtime = runtime_module.restore_runtime(path)

    assert runtime.pair.snapshot()["sides"]["left"]["reference"] is None
    assert runtime_module.restore_runtime(tmp_path / "missing.json").last_timestamp is None


def test_run_writes_on_events_and_heartbeats_and_checkpoints(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_module, "HEARTBEAT_SECONDS", 5.0)
    monkeypatch.setattr(runtime_module, "CHECKPOINT_SECONDS", 30.0)
    records = list(_quiet_bed_records(120))
    connection = _database()
    runtime = runtime_module.Runtime()
    writes = []
    original = runtime_module.write_state

    def recording_write(conn, decisions, current):
        writes.append({side: decisions[side].event for side in decisions})
        original(conn, decisions, current)

    monkeypatch.setattr(runtime_module, "write_state", recording_write)
    path = tmp_path / "checkpoint.json"

    runtime_module.run(FakeFollower(records), connection, runtime, path, now=_fake_clock(records))

    rows = _rows(connection)
    assert rows["left"]["last_event"] == "reference_bootstrap"
    assert {"left": "reference_bootstrap", "right": "reference_bootstrap"} in writes
    # First frame, the bootstrap event, and ~5 s heartbeats — not one write per frame.
    assert 20 <= len(writes) <= 30
    assert json.loads(path.read_text())["history"]["left"]["last_event"] == "reference_bootstrap"


def test_run_survives_a_locked_database(tmp_path, monkeypatch):
    records = list(_quiet_bed_records(3))

    def locked(*_args):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(runtime_module, "write_state", locked)
    runtime_module.run(
        FakeFollower(records),
        _database(),
        runtime_module.Runtime(),
        tmp_path / "checkpoint.json",
        now=_fake_clock(records),
    )

    assert (tmp_path / "checkpoint.json").exists()


def test_open_database_does_not_create_the_migration_owned_table(tmp_path):
    connection = runtime_module.open_database(tmp_path / "biometrics.db")
    tables = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).fetchall()

    assert tables == []
