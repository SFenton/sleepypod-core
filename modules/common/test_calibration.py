"""Regression tests for shared calibration and calibrated presence helpers.

Pins the capSense2 presence formula to the Node occupancy sensor's semantics
(src/lib/occupancy.ts readLevelSignal): summed SIGNED raw-unit deviation from
the calibrated per-channel means, reference-compensated when the frame carries
the REF pair, compared against the profile threshold in raw units.

Field regression (trinity, 2026-08): the former z-score check divided by the
quiet-window std (floored at 0.05), so on firmware whose channel values run in
the hundreds a fraction of a raw unit of thermal drift saturated presence 24/7
— every sleep_records row was exactly MAX_SESSION_S, back to back, on both
sides, and recalibrating (quality 0.99+) made the trigger finer, not coarser.
"""
import json
import sqlite3

import pytest

from common.calibration import (
    CAPSENSE2_REF_NOMINAL,
    CalibrationStore,
    CapCalibrator,
    is_present_capsense2_calibrated,
)


PROFILE = {
    "format": "capSense2",
    "threshold": 6.0,
    "channels": {
        "A": {"mean": 500.0, "std": 0.05},
        "B": {"mean": 600.0, "std": 0.05},
        "C": {"mean": 700.0, "std": 0.05},
    },
    "ref": {"mean": 1.16, "std": 0.001},
}


def _record(a, b, c, ref=None):
    values = [a, a, b, b, c, c]
    if ref is not None:
        values += [ref, ref]
    return {"left": {"values": values}}


class TestCapSense2CalibratedPath:
    def test_global_drift_with_ref_pair_reads_absent(self):
        # The trinity bug: every channel (sensing AND ref) drifted +10 raw
        # units with the water loop's thermal state. Ref compensation cancels
        # it; the old z-score read z = 600 >> 6 and stuck present forever.
        rec = _record(510.0, 610.0, 710.0, ref=11.16)
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is False

    def test_occupant_load_reads_present(self):
        # A person loads the sensing channels while the ref stays at nominal.
        rec = _record(520.0, 620.0, 720.0, ref=1.16)
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is True

    def test_signed_deviations_cancel(self):
        # Mirrors Node: the sum is SIGNED, so opposite drifts cancel instead
        # of accumulating like the old absolute z-sum did.
        rec = _record(510.0, 590.0, 702.0, ref=1.16)  # +10 - 10 + 2 = 2 < 6
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is False

    def test_deviation_exactly_at_threshold_is_absent(self):
        rec = _record(502.0, 602.0, 702.0, ref=1.16)  # 2 + 2 + 2 = 6, not > 6
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is False

    def test_deviation_just_over_threshold_is_present(self):
        rec = _record(502.0, 602.0, 702.1, ref=1.16)  # 6.1 > 6
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is True

    def test_six_value_frame_skips_ref_compensation(self):
        # Newer firmware drops the REF pair; deviation is uncompensated.
        assert is_present_capsense2_calibrated(
            _record(500.0, 600.0, 700.0), "left", PROFILE) is False
        assert is_present_capsense2_calibrated(
            _record(505.0, 603.0, 700.0), "left", PROFILE) is True  # 8 > 6

    def test_profile_without_ref_uses_nominal(self):
        profile = {k: v for k, v in PROFILE.items() if k != "ref"}
        rec = _record(500.0, 600.0, 700.0, ref=CAPSENSE2_REF_NOMINAL)
        assert is_present_capsense2_calibrated(rec, "left", profile) is False

    def test_profile_threshold_is_respected(self):
        profile = dict(PROFILE, threshold=50.0)
        rec = _record(510.0, 610.0, 710.0, ref=1.16)  # deviation 30
        assert is_present_capsense2_calibrated(rec, "left", profile) is False
        rec = _record(520.0, 620.0, 720.0, ref=1.16)  # deviation 60
        assert is_present_capsense2_calibrated(rec, "left", profile) is True


class TestCapSense2FallbackPath:
    def test_no_profile_falls_back_to_raw_sum(self):
        assert is_present_capsense2_calibrated(
            _record(30.0, 20.0, 15.0), "left", None) is True   # 65 > 60
        assert is_present_capsense2_calibrated(
            _record(10.0, 10.0, 10.0), "left", None) is False  # 30 < 60

    def test_mismatched_format_falls_back_to_raw_sum(self):
        assert is_present_capsense2_calibrated(
            _record(30.0, 20.0, 15.0), "left", {"format": "capSense"}) is True

    def test_short_or_missing_values_read_absent(self):
        assert is_present_capsense2_calibrated(
            {"left": {"values": [1.0, 2.0, 3.0]}}, "left", PROFILE) is False
        assert is_present_capsense2_calibrated({"left": {}}, "left", PROFILE) is False
        assert is_present_capsense2_calibrated({}, "left", PROFILE) is False
def cap_records(count, value=lambda i: 1000):
    return [
        {
            "type": "capSense",
            "ts": 1_700_000_000 + i,
            "left": {
                "out": value(i),
                "cen": value(i) + 100,
                "in": value(i) + 200,
            },
        }
        for i in range(count)
    ]


def create_store(tmp_path):
    db_path = tmp_path / "biometrics.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE calibration_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          side TEXT NOT NULL,
          sensor_type TEXT NOT NULL,
          status TEXT NOT NULL,
          parameters TEXT NOT NULL,
          quality_score REAL,
          source_window_start INTEGER,
          source_window_end INTEGER,
          samples_used INTEGER,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER
        );
        CREATE UNIQUE INDEX uq_cal_side_type_active
          ON calibration_profiles (side, sensor_type);
        """
    )
    conn.close()
    return CalibrationStore(db_path)


def test_named_capsense_waits_for_a_complete_candidate_window():
    with pytest.raises(ValueError, match=r"299 samples.*need ≥300"):
        CapCalibrator().calibrate(cap_records(299), "left")


def test_named_capsense_exact_window_is_finite_and_high_quality():
    result = CapCalibrator().calibrate(cap_records(300), "left")

    assert result.samples_used == 300
    assert result.quality_score == 1.0
    assert result.params["channels"]["out"] == {"mean": 1000.0, "std": 5.0}


def test_named_capsense_selects_a_quiet_complete_window():
    records = cap_records(
        600,
        value=lambda i: (0 if i % 2 else 1000) if i < 300 else 2000,
    )

    result = CapCalibrator().calibrate(records, "left")

    assert result.window_start == records[300]["ts"]
    assert result.window_end == records[599]["ts"]
    assert result.quality_score == 1.0


def test_named_capsense_rejects_a_window_at_the_quality_floor():
    records = cap_records(300, value=lambda i: 0 if i % 2 else 1000)

    with pytest.raises(ValueError, match="No stable capSense calibration window"):
        CapCalibrator().calibrate(records, "left")


def test_named_capsense_rejects_quality_that_rounds_to_zero():
    calibrator = CapCalibrator()
    records = cap_records(300, value=lambda i: 0 if i % 2 else 100)
    # Three channels each contribute variance 2,500. Set the scale just above
    # that total so the raw score is positive but would persist as 0.000.
    calibrator.VARIANCE_QUALITY_SCALE = 7500.5

    with pytest.raises(ValueError, match="No stable capSense calibration window"):
        calibrator.calibrate(records, "left")


def test_zero_quality_profile_is_not_active(tmp_path):
    store = create_store(tmp_path)
    try:
        # Simulate a profile written by a pre-fix build, bypassing the current
        # store guard so the backwards-compatibility read path is exercised.
        with store._get_conn() as conn:
            conn.execute(
                """INSERT INTO calibration_profiles
                   (side, sensor_type, status, parameters, quality_score, created_at)
                   VALUES ('left', 'capacitance', 'completed', '{}', 0.0, 1)"""
            )

        assert store.get_active("left", "capacitance") is None
    finally:
        store.close()


def test_store_refuses_to_activate_zero_quality_from_any_calibrator(tmp_path):
    store = create_store(tmp_path)
    try:
        with pytest.raises(ValueError, match="Refusing unusable left/capacitance"):
            store.upsert_profile(
                "left", "capacitance", {"channels": {}}, 0.0, 1, 300, 300
            )

        row = store._get_conn().execute(
            "SELECT COUNT(*) FROM calibration_profiles"
        ).fetchone()
        assert row[0] == 0
    finally:
        store.close()


def test_failed_replacement_keeps_completed_profile_active(tmp_path):
    store = create_store(tmp_path)
    try:
        params = {"channels": {"out": {"mean": 1, "std": 5}}}
        store.upsert_profile("left", "capacitance", params, 1.0, 1, 300, 300)

        store.mark_running("left", "capacitance")
        store.mark_failed("left", "capacitance", "new window was noisy")

        active = store.get_active("left", "capacitance")
        assert active is not None
        assert active["status"] == "completed"
        assert json.loads(active["parameters"]) == params
        assert active["quality_score"] == 1.0
        assert active["error_message"] is None
    finally:
        store.close()


def test_first_failed_calibration_remains_retryable(tmp_path):
    store = create_store(tmp_path)
    try:
        store.mark_running("right", "capacitance")
        store.mark_failed("right", "capacitance", "buffer still warming")

        assert store.get_active("right", "capacitance") is None
        row = store._get_conn().execute(
            "SELECT status, error_message FROM calibration_profiles "
            "WHERE side='right' AND sensor_type='capacitance'"
        ).fetchone()
        assert tuple(row) == ("failed", "buffer still warming")
    finally:
        store.close()
