"""
Tests for sleep-detector. Runs on developer Mac without pod-only deps —
cbor2 / common.raw_follower / common.health are stubbed before importing main.
Covers ts sanitization (#327) and DB write resilience (#325).
"""

import logging
import sqlite3
import sys
from datetime import datetime, timezone
from unittest.mock import patch

# Stub pod-only modules so `import main` works on dev machines.
_stubs = {
    "cbor2": type(sys)("cbor2"),
    "common": type(sys)("common"),
    "common.raw_follower": type(sys)("common.raw_follower"),
    "common.nats_follower": type(sys)("common.nats_follower"),
    "common.dialect": type(sys)("common.dialect"),
    "common.calibration": type(sys)("common.calibration"),
    "common.health": type(sys)("common.health"),
}
_stubs["common.raw_follower"].RawFileFollower = None
_stubs["common.nats_follower"].create_follower = None
_stubs["common.dialect"].KNOWN_RECORD_TYPES = frozenset()
_stubs["common.dialect"].warn_unknown_type_once = lambda *a, **kw: None
_stubs["common.dialect"].log_capsense_status_once = lambda *a, **kw: None
_stubs["common.calibration"].CalibrationStore = None
_stubs["common.calibration"].is_present_capsense_calibrated = lambda *a, **kw: False
_stubs["common.calibration"].is_present_capsense2_calibrated = lambda *a, **kw: False
_stubs["common.health"].report_health = lambda *a, **kw: None
sys.modules.update(_stubs)

import main  # noqa: E402
from main import sanitize_ts, MIN_VALID_WALL_CLOCK_TS  # noqa: E402


class TestSanitizeTs:
    """sleep_records id=30 had entered_bed_at=3 (1970-01-01 00:00:03 UTC).
    Root cause: a fresh RAW file post-restart can carry tiny relative ts
    values; the prior code passed them straight through to
    datetime.fromtimestamp() and persisted them as entered_bed_at."""

    def test_passes_through_valid_wall_clock(self):
        valid = 1777731963.0  # 2026-05-02 14:26 UTC
        assert sanitize_ts(valid) == valid

    def test_substitutes_wall_clock_when_ts_is_pre_2020_sentinel(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(3.0) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_zero(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(0) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_negative(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(-100) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_missing(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(None) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_not_a_number(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts("notanumber") == 1777731963.0

    def test_threshold_boundary(self):
        # Exactly at 2020-01-01 should be considered valid (>=).
        assert sanitize_ts(MIN_VALID_WALL_CLOCK_TS) == MIN_VALID_WALL_CLOCK_TS

    def test_just_below_threshold_is_replaced(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(MIN_VALID_WALL_CLOCK_TS - 1) == 1777731963.0

    def test_real_observed_bug_value(self):
        """The exact value (ts=3) found in sleep_records id=30 on the pod
        on 2026-03-21 — must be sanitized."""
        sentinel_now = 1700000000.0  # arbitrary post-2020 wall-clock
        with patch("main.time.time", return_value=sentinel_now):
            result = sanitize_ts(3.0)
            assert result == sentinel_now
            # Sanity: result is a real wall-clock value, not 1970-era.
            assert result >= MIN_VALID_WALL_CLOCK_TS

    def test_handles_int_input(self):
        valid_int = 1777731963
        assert sanitize_ts(valid_int) == float(valid_int)

    def test_substitutes_wall_clock_when_ts_is_nan(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(float("nan")) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_positive_inf(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(float("inf")) == 1777731963.0

    def test_substitutes_wall_clock_when_ts_is_negative_inf(self):
        with patch("main.time.time", return_value=1777731963.0):
            assert sanitize_ts(float("-inf")) == 1777731963.0


def _make_db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """CREATE TABLE sleep_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            side TEXT, entered_bed_at INTEGER, left_bed_at INTEGER,
            sleep_duration_seconds INTEGER, times_exited_bed INTEGER,
            present_intervals TEXT, not_present_intervals TEXT,
            created_at INTEGER
        )"""
    )
    conn.execute(
        """CREATE TABLE movement (
            side TEXT, timestamp INTEGER, total_movement INTEGER,
            PRIMARY KEY (side, timestamp)
        )"""
    )
    return conn


class _FailingConn:
    """Connection that always raises OperationalError on execute."""

    def __init__(self):
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a, **k):
        raise sqlite3.OperationalError("disk I/O error")

    def close(self):
        self.closed = True


class TestWriteMovementResilience:
    def test_happy_path_inserts_row(self):
        holder = main.DBHolder(_make_db())
        main._db_write_failures = 0
        wrote = main.write_movement(holder, "left",
                                    datetime.now(timezone.utc), 42)
        assert wrote is True
        rows = holder.conn.execute("SELECT * FROM movement").fetchall()
        assert len(rows) == 1

    def test_sqlite_error_swallowed(self):
        main._db_write_failures = 0
        holder = main.DBHolder(_FailingConn())
        # Should not raise
        wrote = main.write_movement(holder, "left",
                                    datetime.now(timezone.utc), 42)
        assert wrote is False

    def test_reconnect_after_threshold(self, monkeypatch):
        replaced = []

        def fake_open():
            replaced.append(1)
            return _make_db()

        main._db_write_failures = 0
        monkeypatch.setattr(main, "open_biometrics_db", fake_open)
        holder = main.DBHolder(_FailingConn())
        for _ in range(main._DB_RECONNECT_THRESHOLD):
            main.write_movement(holder, "left",
                                datetime.now(timezone.utc), 42)
        assert len(replaced) == 1
        assert main._db_write_failures == 0
        # Both trackers would now see the swapped connection.
        assert holder.conn is not None


class TestWriteSleepRecordResilience:
    def test_happy_path_inserts_row(self):
        holder = main.DBHolder(_make_db())
        main._db_write_failures = 0
        entered = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        left = datetime.fromtimestamp(1_700_028_800, tz=timezone.utc)
        wrote = main.write_sleep_record(
            holder, "left", entered, left, 28_800, 2, [[1, 2]], [[3, 4]],
        )
        assert wrote is True
        rows = holder.conn.execute("SELECT * FROM sleep_records").fetchall()
        assert len(rows) == 1

    def test_sqlite_error_swallowed(self):
        main._db_write_failures = 0
        entered = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        left = datetime.fromtimestamp(1_700_028_800, tz=timezone.utc)
        # Should not raise
        wrote = main.write_sleep_record(
            main.DBHolder(_FailingConn()), "left", entered, left, 28_800, 0, [], [],
        )
        assert wrote is False

    def test_reconnect_after_threshold(self, monkeypatch):
        replaced = []

        def fake_open():
            replaced.append(1)
            return _make_db()

        main._db_write_failures = 0
        monkeypatch.setattr(main, "open_biometrics_db", fake_open)
        entered = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        left = datetime.fromtimestamp(1_700_028_800, tz=timezone.utc)

        holder = main.DBHolder(_FailingConn())
        for _ in range(main._DB_RECONNECT_THRESHOLD):
            main.write_sleep_record(
                holder, "left", entered, left, 28_800, 0, [], [],
            )
        assert len(replaced) == 1
        assert main._db_write_failures == 0


class TestSharedConnectionHolder:
    """Both SessionTrackers read connections from one DBHolder so reconnect
    on either side automatically updates the other's view (no orphaned
    handles after a reconnect)."""

    def test_reconnect_swaps_holder_observed_by_both_trackers(self, monkeypatch):
        original = _make_db()
        replacement = _make_db()
        opens = iter([replacement])
        monkeypatch.setattr(main, "open_biometrics_db", lambda: next(opens))

        holder = main.DBHolder(original)
        main._reconnect_db(holder)

        assert holder.conn is replacement
        # The original closed-handle is no longer referenced by the holder, so
        # any tracker reading from holder.conn observes the live connection.


class TestPumpGatePerSide:
    """Gating both beds whenever EITHER pump ran zeroed real movement on the
    idle side for the whole pump runtime, under-counting the movement table.
    Signal 1 (RPM) and Signal 3 (guard period) are now per-side; cross-side
    mechanical coupling remains covered by Signal 2 (correlated ref-anomaly)."""

    def _frz(self, left_rpm, right_rpm):
        return {
            "type": "frzHealth",
            "left": {"pumpRpm": left_rpm},
            "right": {"pumpRpm": right_rpm},
        }

    def test_only_running_side_is_gated(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=3000, right_rpm=0))

        assert gate.is_gated({}, "left") is True
        assert gate.is_gated({}, "right") is False

    def test_both_sides_gated_when_both_pumps_run(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=3000, right_rpm=2800))

        assert gate.is_gated({}, "left") is True
        assert gate.is_gated({}, "right") is True

    def test_guard_period_applies_per_side(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=3000, right_rpm=0))
        # Left pump turns off → left enters its guard period; right never ran.
        gate.update_pump_state(self._frz(left_rpm=0, right_rpm=0))

        assert gate.is_gated({}, "left") is True, "guard period must gate the side that ran"
        assert gate.is_gated({}, "right") is False, "idle side must not inherit the guard"

    def test_no_pumps_no_gate(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state(self._frz(left_rpm=0, right_rpm=0))

        assert gate.is_gated({}, "left") is False
        assert gate.is_gated({}, "right") is False

    def test_captured_nats_nested_health_rpm(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state({
            "type": "frzHealth",
            "left": {"pump": {"mode": "pwm", "rpm": 1868, "water": True}},
            "right": {"pump": {"mode": "pwm", "rpm": 0, "water": True}},
        })
        assert gate.is_gated({}, "left") is True
        assert gate.is_gated({}, "right") is False

    def test_captured_nats_therm_power(self):
        gate = main.PumpGateCapSense()
        gate.update_pump_state({
            "type": "frzTherm",
            "left": {"power": 0.024},
            "right": {"power": 0.0},
        })
        assert gate.is_gated({}, "left") is True
        assert gate.is_gated({}, "right") is False


def _tracker():
    """A SessionTracker wired to an in-memory DB. calibration/pump_gate are
    unused by _update, so None is sufficient for presence/session tests."""
    holder = main.DBHolder(_make_db())
    main._db_write_failures = 0
    return main.SessionTracker(side="left", db=holder,
                               calibration=None, pump_gate=None)


def _feed(t, samples):
    """Feed (ts, present) pairs through _update with zero movement."""
    for ts, present in samples:
        t._update(ts, present, 0.0)


def _rows(t):
    return t.db.conn.execute(
        "SELECT sleep_duration_seconds, times_exited_bed FROM sleep_records"
    ).fetchall()


class TestPresenceDebounce:
    """Pod 88 field debug 2026-06-10: brief capSense dropouts fragmented one
    overnight presence span into dozens of <15min sleep_records with 66-109
    bogus bed-exits and runaway durations. Presence is now debounced."""

    def test_brief_dropout_does_not_increment_exit_or_split_session(self):
        t = _tracker()
        base = 1_777_000_000.0
        samples = []
        # Establish committed presence (sustain past PRESENCE_DEBOUNCE_S).
        samples += [(base, True), (base + 31, True)]
        # 8h in bed at 2 Hz would be huge; sample sparsely but inject many
        # sub-debounce dropouts — each a single absent sample immediately
        # followed by present. None should commit a flip.
        ts = base + 31
        for _ in range(50):
            ts += 60
            samples.append((ts, False))   # brief dropout
            samples.append((ts + 1, True))  # back within 1s — under debounce
        # Real morning exit: sustained absence past debounce + absence timeout.
        exit_ts = ts + 3600
        samples.append((exit_ts, False))
        samples.append((exit_ts + 31, False))   # commits absent flip → 1 exit
        samples.append((exit_ts + 200, False))  # > ABSENCE_TIMEOUT_S → close
        _feed(t, samples)

        rows = _rows(t)
        assert len(rows) == 1
        duration_s, exits = rows[0]
        assert exits == 1
        # One continuous span: duration ~ (exit_ts - base), well over an hour.
        assert duration_s >= 3600

    def test_sustained_absence_counts_single_exit(self):
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        # Genuine bed-exit: absence sustained past debounce, then past the
        # absence timeout so the session closes on that one exit.
        leave = base + 4000
        samples += [(leave, False), (leave + 31, False), (leave + 200, False)]
        _feed(t, samples)

        rows = _rows(t)
        assert len(rows) == 1
        _duration, exits = rows[0]
        assert exits == 1

    def test_runaway_session_is_capped(self):
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        # Presence that never goes absent for > MAX_SESSION_S of wall-clock.
        ts = base + 31
        while ts < base + main.MAX_SESSION_S + 7200:
            ts += 600
            samples.append((ts, True))
        _feed(t, samples)

        rows = _rows(t)
        assert len(rows) >= 1
        # No row exceeds the hard cap.
        for duration_s, _exits in rows:
            assert duration_s <= main.MAX_SESSION_S

    def test_consecutive_cap_closes_warn_and_escalate(self, caplog):
        # Trinity field report 2026-08: back-to-back rows of exactly
        # MAX_SESSION_S meant a stuck presence signal, silently. The cap
        # must surface itself, and two in a row must escalate.
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        ts = base + 31
        while ts < base + 2 * main.MAX_SESSION_S + 7200:
            ts += 600
            samples.append((ts, True))
        with caplog.at_level(logging.WARNING):
            _feed(t, samples)

        caps = [r for r in caplog.records if "force-closed" in r.getMessage()]
        assert len(caps) >= 2
        stuck = [r for r in caplog.records if "stuck-occupied" in r.getMessage()]
        assert len(stuck) >= 1

    def test_natural_exit_resets_cap_close_streak(self, caplog):
        t = _tracker()
        base = 1_777_000_000.0
        samples = [(base, True), (base + 31, True)]
        # Close precisely at the cap, then explicitly start a new session.
        ts = base + 31 + main.MAX_SESSION_S
        samples.append((ts, True))
        restart = ts + 600
        samples += [(restart, True), (restart + 31, True)]
        leave = restart + 60
        samples += [(leave, False), (leave + 31, False), (leave + 200, False)]
        # Back in bed and past the cap once more.
        back = leave + 400
        samples += [(back, True), (back + 31, True)]
        ts = back + 31
        while ts < back + main.MAX_SESSION_S + 3600:
            ts += 600
            samples.append((ts, True))
        with caplog.at_level(logging.WARNING):
            _feed(t, samples)

        caps = [r for r in caplog.records if "force-closed" in r.getMessage()]
        assert len(caps) == 2
        assert all("(1 consecutive)" in r.getMessage() for r in caps)
        assert [r for r in caplog.records if "stuck-occupied" in r.getMessage()] == []


def _restart(old, now):
    """Round-trip old's snapshot through JSON into a fresh tracker on the same
    DB — what a service restart or pod reboot does via the state file."""
    import json
    t = main.SessionTracker(side=old.side, db=old.db, calibration=None, pump_gate=None)
    t.restore(json.loads(json.dumps(old.snapshot())), now)
    return t


def _rows_full(t):
    return t.db.conn.execute(
        "SELECT entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed "
        "FROM sleep_records").fetchall()


class TestSessionPersistence:
    """A reboot or restart mid-session used to drop the open session — it
    only lived in memory, so the night never reached sleep_records."""

    BASE = 1_777_000_000.0

    def _asleep(self, hours=6):
        t = _tracker()
        ts = self.BASE
        samples = [(ts, True), (ts + 31, True)]
        while ts < self.BASE + hours * 3600:
            ts += 60
            samples.append((ts, True))
        _feed(t, samples)
        return t, ts

    def test_reboot_mid_sleep_resumes_one_session(self):
        t, ts = self._asleep()
        t = _restart(t, now=ts + 300)          # 5 min reboot, still in bed
        wake = ts + 300 + 2 * 3600
        samples = [(ts + 300 + i * 60, True) for i in range(1, 121)]
        samples += [(wake, False), (wake + 31, False), (wake + 200, False)]
        _feed(t, samples)

        rows = _rows_full(t)
        assert len(rows) == 1
        entered, left_at, duration_s, exits = rows[0]
        assert entered == int(self.BASE)
        assert left_at == int(wake)
        assert exits == 1
        assert duration_s == int(wake - self.BASE)

    def test_left_bed_during_downtime_closes_at_last_presence(self):
        t, ts = self._asleep()
        t = _restart(t, now=ts + 600)          # back up 10 min later, bed empty
        _feed(t, [(ts + 600, False), (ts + 631, False), (ts + 800, False)])

        rows = _rows_full(t)
        assert len(rows) == 1
        _entered, left_at, duration_s, exits = rows[0]
        # Dated at the last pre-restart presence, not the first sample after.
        assert left_at == int(ts)
        assert duration_s == int(ts - self.BASE)
        assert exits == 1

    def test_stale_saved_session_is_closed_not_resumed(self):
        t, ts = self._asleep()
        t = _restart(t, now=ts + main.STATE_MAX_GAP_S + 1)

        rows = _rows_full(t)
        assert len(rows) == 1
        assert rows[0][1] == int(ts)           # closed at last presence
        assert t.snapshot()["session_start"] is None
        assert t.state_dirty is True

    def test_replayed_samples_are_skipped_after_restore(self):
        class _NoCal:
            def get_baselines(self, side):
                return None

        t, ts = self._asleep(hours=1)
        t = _restart(t, now=ts + 60)
        t.calibration = _NoCal()
        t.pump_gate = main.PumpGateCapSense()
        rec = {"type": "capSense", "left": {"out": 1, "cen": 1, "in": 1}}

        t.process(ts - 600, rec)               # replay from the RAW file start
        assert t._last_ts == ts
        t.process(ts, rec)
        assert t._last_ts == ts
        t.process(ts + 1, rec)                 # first genuinely new sample
        assert t._last_ts == ts + 1
        assert t._replay_until_ts is None

    def test_idle_tracker_keeps_cap_close_streak_only(self):
        t = _tracker()
        t._consecutive_cap_closes = 2
        t = _restart(t, now=self.BASE)
        assert t._consecutive_cap_closes == 2
        assert t.snapshot()["session_start"] is None

    def test_corrupt_saved_session_is_ignored(self):
        t = _tracker()
        t.restore({"session_start": "not-a-number"}, now=self.BASE)
        assert t.snapshot()["session_start"] is None
        t.restore(None, now=self.BASE)
        t.restore(["not", "a", "dict"], now=self.BASE)
        assert _rows(t) == []

    def test_session_start_close_and_exit_mark_state_dirty(self):
        t = _tracker()
        _feed(t, [(self.BASE, True), (self.BASE + 31, True)])
        assert t.state_dirty is True
        t.state_dirty = False
        leave = self.BASE + 4000
        _feed(t, [(leave, False), (leave + 31, False)])
        assert t.state_dirty is True            # bed-exit
        t.state_dirty = False
        _feed(t, [(leave + 200, False)])
        assert t.state_dirty is True            # session closed


class TestStateFile:
    def test_round_trip(self, tmp_path):
        t = _tracker()
        _feed(t, [(1_777_000_000.0, True), (1_777_000_031.0, True)])
        path = tmp_path / "state.json"
        assert main.save_state(path, (t,)) is True
        state = main.load_state(path)
        assert state["version"] == main.STATE_VERSION
        assert state["left"]["session_start"] == 1_777_000_000.0
        assert not (tmp_path / "state.json.tmp").exists()

    def test_missing_file_is_empty(self, tmp_path):
        assert main.load_state(tmp_path / "nope.json") == {}

    def test_corrupt_or_foreign_file_is_empty(self, tmp_path):
        path = tmp_path / "state.json"
        path.write_text("{truncated")
        assert main.load_state(path) == {}
        path.write_text('{"version": 999, "left": {}}')
        assert main.load_state(path) == {}
        path.write_text("[1, 2]")
        assert main.load_state(path) == {}

    def test_unwritable_path_reports_failure(self, tmp_path):
        assert main.save_state(tmp_path / "missing-dir" / "state.json", (_tracker(),)) is False
