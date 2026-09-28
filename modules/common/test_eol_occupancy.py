"""Synthetic streaming coverage for the EoL occupancy detector."""

from __future__ import annotations

import base64
import gzip
import json
import math
import struct
from dataclasses import asdict
from functools import lru_cache

import pytest

from common.eol_occupancy import (
    ALGORITHM_VERSION,
    EolPair,
    OCCUPIED,
    PROVISIONAL,
    SOS_MOTION,
)


BASE = 1000.0


def _wave_blocks(amplitude: float, second: int):
    return [
        amplitude * math.sin(2.0 * math.pi * 1.2 * (second + index / 25.0))
        for index in range(25)
    ]


@lru_cache(maxsize=1)
def _energy_scale() -> float:
    """Measure the public E20 output so synthetic targets are signal-derived."""

    pair = EolPair()
    for second in range(40):
        pair.update_piezo_blocks(
            second,
            _wave_blocks(1.0, second),
            [0.0] * 25,
            False,
            False,
        )
    decision = pair.update_cap(
        40.0,
        [BASE, BASE + 0.1, BASE],
        [BASE, BASE + 0.2, BASE],
    )
    assert decision is not None
    energy = decision["left"].diagnostics["e20_own"]
    assert energy is not None and energy > 0.0
    return energy


def _blocks_for_energy(target: float, second: int):
    if target == 0.0:
        return [0.0] * 25
    return _wave_blocks(target / _energy_scale(), second)


def _cap_values(second: int, load: float, breathing: float, phase: int):
    # Quiet sub-count drift keeps otherwise flat synthetic samples unique
    # without crossing any movement threshold.
    noise = ((second * 7 + phase * 3) % 19 - 9) * 0.1
    center_motion = breathing if second % 2 else -breathing
    return [
        BASE + load + noise,
        BASE + load + noise + center_motion,
        BASE + load + noise,
    ]


def _feed(
    pair: EolPair,
    second: int,
    *,
    left_load: float = 0.0,
    right_load: float = 0.0,
    left_breathing: float = 0.0,
    right_breathing: float = 0.0,
    left_energy: float = 0.0,
    right_energy: float = 0.0,
    piezo: bool = True,
    left_saturated: bool = False,
    right_saturated: bool = False,
):
    if piezo:
        pair.update_piezo_blocks(
            float(second),
            _blocks_for_energy(left_energy, second),
            _blocks_for_energy(right_energy, second),
            left_saturated,
            right_saturated,
        )
    decision = pair.update_cap(
        float(second),
        _cap_values(second, left_load, left_breathing, 0),
        _cap_values(second, right_load, right_breathing, 1),
    )
    assert decision is not None
    return decision


def _bootstrap(pair: EolPair, start: int = 0, piezo: bool = True) -> int:
    events = []
    for second in range(start, start + 65):
        decisions = _feed(pair, second, piezo=piezo)
        events.extend(
            decision.event
            for decision in decisions.values()
            if decision.event is not None
        )
    assert events.count("reference_bootstrap") == 2
    return start + 65


def _enter_confirmed(
    pair: EolPair,
    start: int,
    *,
    left_energy: float = 100_000.0,
    right_energy: float = 1_000.0,
    breathing: float = 10.0,
    piezo: bool = True,
) -> int:
    entry_at = None
    confirmed_at = None
    for second in range(start, start + 55):
        decisions = _feed(
            pair,
            second,
            left_load=800.0,
            left_breathing=breathing,
            left_energy=left_energy,
            right_energy=right_energy,
            piezo=piezo,
        )
        left = decisions["left"]
        if left.event == "entry_step":
            entry_at = second
        if left.event == "entry_confirmed":
            confirmed_at = second
            assert left.state == OCCUPIED
    assert entry_at is not None
    assert confirmed_at is not None
    return start + 55


def test_empty_bed_bootstraps_reference_and_stays_empty():
    pair = EolPair()
    end = _bootstrap(pair)
    decision = _feed(pair, end)

    assert decision["left"].state == "empty"
    assert decision["right"].state == "empty"
    snapshot = pair.snapshot()
    assert snapshot["algorithm_version"] == ALGORITHM_VERSION
    assert snapshot["sides"]["left"]["reference"] is not None
    assert snapshot["sides"]["right"]["reference"] is not None


def test_entry_is_fast_then_confirmed_by_sustained_load_motion_and_vitals():
    pair = EolPair()
    start = _bootstrap(pair)
    entry_at = None
    confirmed_at = None

    for second in range(start, start + 55):
        decisions = _feed(
            pair,
            second,
            left_load=800.0,
            left_breathing=10.0,
            left_energy=100_000.0,
            right_energy=1_000.0,
        )
        left = decisions["left"]
        if left.event == "entry_step":
            entry_at = second
            assert left.state == PROVISIONAL
            assert left.occupied and not left.confirmed
        if left.event == "entry_confirmed":
            confirmed_at = second
            assert left.confirmed
            assert left.diagnostics["mv60"] is not None
            assert left.diagnostics["mv60"] >= 9.0
            assert left.diagnostics["e20_own"] >= 60_000.0

    assert entry_at is not None and entry_at - start <= 3
    assert confirmed_at is not None and confirmed_at > entry_at


def test_fifteen_second_visit_clears_within_fifteen_seconds_of_unload():
    pair = EolPair()
    start = _bootstrap(pair)
    for second in range(start, start + 15):
        _feed(
            pair,
            second,
            left_load=800.0,
            left_energy=100_000.0,
            right_energy=1_000.0,
        )

    cleared_at = None
    for second in range(start + 15, start + 31):
        decision = _feed(pair, second)
        if decision["left"].event == "exit_step":
            cleared_at = second
            assert decision["left"].state == "empty"
            break

    assert cleared_at is not None
    assert cleared_at - (start + 15) <= 15


def test_rollover_dip_does_not_clear_a_living_occupied_side():
    pair = EolPair()
    second = _enter_confirmed(pair, _bootstrap(pair))

    for second in range(second, second + 5):
        decision = _feed(
            pair,
            second,
            left_load=0.0,
            left_breathing=10.0,
            left_energy=100_000.0,
            right_energy=1_000.0,
        )
        assert decision["left"].state != "empty"
    for second in range(second + 5, second + 30):
        decision = _feed(
            pair,
            second,
            left_load=800.0,
            left_breathing=10.0,
            left_energy=100_000.0,
            right_energy=1_000.0,
        )
        assert decision["left"].state == OCCUPIED
        assert decision["left"].event != "exit_step"


def test_object_placement_is_revoked_before_confirmation():
    pair = EolPair()
    start = _bootstrap(pair)
    entry_at = None
    events = []

    for second in range(start, start + 160):
        decisions = _feed(
            pair,
            second,
            left_load=800.0,
            left_energy=100_000.0 if second < start + 2 else 1_000.0,
            right_energy=1_000.0,
        )
        left = decisions["left"]
        if left.event is not None:
            events.append((second, left.event))
        if left.event == "entry_step":
            entry_at = second
        assert not left.confirmed

    revoked = [second for second, event in events if event == "entry_revoked"]
    assert entry_at is not None
    assert revoked and revoked[0] - entry_at <= 150


def test_post_exit_rebound_does_not_reenter_over_thirty_minutes():
    pair = EolPair()
    second = _enter_confirmed(pair, _bootstrap(pair))

    exited = False
    for second in range(second, second + 20):
        decision = _feed(pair, second)
        if decision["left"].event == "exit_step":
            exited = True
            second += 1
            break
    assert exited

    for offset in range(1800):
        decision = _feed(
            pair,
            second + offset,
            left_load=150.0 * offset / 1799.0,
        )
        assert decision["left"].state == "empty"
        assert decision["left"].event not in ("entry_step", "entry_life")


def test_still_sleeper_beside_active_partner_is_not_cleared():
    pair = EolPair()
    second = _enter_confirmed(pair, _bootstrap(pair))

    for second in range(second, second + 1800):
        decision = _feed(
            pair,
            second,
            left_load=800.0,
            left_breathing=5.0,
            left_energy=65_000.0,
            right_energy=216_000.0,
        )
        assert decision["left"].state == OCCUPIED
        assert decision["left"].event not in (
            "exit_step",
            "exit_absence",
            "exit_no_vitals",
        )
    diagnostics = decision["left"].diagnostics
    assert diagnostics["e20_own"] / diagnostics["e20_partner"] == pytest.approx(
        0.3,
        rel=0.12,
    )
    assert 8.0 <= diagnostics["mv60"] <= 12.0


def test_empty_side_beside_still_sleeper_never_enters():
    pair = EolPair()
    second = _bootstrap(pair)

    for second in range(second, second + 1800):
        decision = _feed(
            pair,
            second,
            left_energy=65_000.0,
            right_energy=65_000.0,
        )
        assert decision["left"].state == "empty"
        assert decision["left"].event not in ("entry_step", "entry_life")


def test_loaded_side_without_vitals_exits_after_about_ten_minutes():
    pair = EolPair()
    second = _enter_confirmed(pair, _bootstrap(pair))
    no_vitals_start = second
    no_vitals_at = None

    for second in range(second, second + 630):
        decision = _feed(
            pair,
            second,
            left_load=800.0,
            left_energy=1_000.0,
            right_energy=1_000.0,
        )
        if decision["left"].event == "exit_no_vitals":
            no_vitals_at = second
            break

    assert no_vitals_at is not None
    assert 600 <= no_vitals_at - no_vitals_start <= 640
    assert decision["left"].state == "empty"


def test_saturated_piezo_second_cannot_make_a_spurious_entry():
    pair = EolPair()
    second = _bootstrap(pair)
    saturated = [2147483646] * 500
    pair.update_piezo_raw(float(second), saturated, [0] * 500)
    decision = pair.update_cap(
        float(second),
        _cap_values(second, 0.0, 0.0, 0),
        _cap_values(second, 0.0, 0.0, 1),
    )
    assert decision is not None
    assert decision["left"].state == "empty"
    assert decision["left"].event != "entry_step"


def test_duplicate_capsense_frame_returns_none_without_advancing_runs():
    pair = EolPair()
    for second in range(5):
        _feed(pair, second)
    left = [1010.0, 1010.0, 1010.0]
    right = [1020.0, 1020.0, 1020.0]
    first = pair.update_cap(5.0, left, right)
    assert first is not None
    before = pair.snapshot()
    assert pair.update_cap(5.5, left, right) is None
    after = pair.snapshot()
    assert after["sides"] == before["sides"]
    assert after["last_cap_timestamp"] == before["last_cap_timestamp"]


def test_degraded_mode_marks_decisions_and_requires_ten_exit_evaluations():
    pair = EolPair()
    start = _bootstrap(pair, piezo=False)
    second = _enter_confirmed(
        pair,
        start,
        breathing=10.0,
        piezo=False,
    )

    candidate_at = None
    clear_at = None
    qualifying = 0
    for second in range(second, second + 45):
        decision = _feed(pair, second, piezo=False)
        left = decision["left"]
        assert left.degraded
        if pair.snapshot()["sides"]["left"]["candidate_at"] is not None:
            candidate_at = second if candidate_at is None else candidate_at
        if candidate_at is not None and left.state != "empty":
            qualifying += 1
        if left.event == "exit_step":
            clear_at = second
            break

    assert candidate_at is not None
    assert clear_at is not None
    assert clear_at - candidate_at >= 10
    assert qualifying >= 10


def test_snapshot_restore_preserves_state_reference_and_following_decisions():
    pair = EolPair()
    second = _enter_confirmed(pair, _bootstrap(pair))
    snapshot = json.loads(json.dumps(pair.snapshot()))
    restored = EolPair.from_snapshot(snapshot)

    assert restored.snapshot()["sides"]["left"]["reference"] == pair.snapshot()["sides"]["left"]["reference"]
    assert restored.snapshot()["sides"]["left"]["state"] == OCCUPIED
    for second in range(second, second + 40):
        kwargs = {
            "left_load": 800.0,
            "left_breathing": 10.0,
            "left_energy": 100_000.0,
            "right_energy": 1_000.0,
        }
        original = _feed(pair, second, **kwargs)
        resumed = _feed(restored, second, **kwargs)
        assert asdict(original["left"]) == asdict(resumed["left"])
        assert asdict(original["right"]) == asdict(resumed["right"])


def test_replay_cli_reads_a_synthetic_cbor_chunk(tmp_path):
    cbor2 = pytest.importorskip("cbor2")
    from common.eol_replay import main

    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    chunk = raw_dir / "synthetic.jsonl.gz"
    records = [
        {"kind": "chunk", "format_version": 1},
        {
            "kind": "message",
            "subject": "raw.sens.piezo",
            "server_timestamp": 1.0,
            "stream_sequence": 1,
            "payload_b64": base64.b64encode(
                cbor2.dumps({
                    "type": "piezo-dual",
                    "left1": struct.pack("<500i", *([0] * 500)),
                    "right1": struct.pack("<500i", *([0] * 500)),
                })
            ).decode("ascii"),
        },
        {
            "kind": "message",
            "subject": "raw.sens.capsense",
            "server_timestamp": 2.0,
            "stream_sequence": 2,
            "payload_b64": base64.b64encode(
                cbor2.dumps({
                    "type": "capSense",
                    "left": {"out": 1000, "cen": 1001, "in": 1000, "status": "good"},
                    "right": {"out": 1000, "cen": 1002, "in": 1000, "status": "good"},
                })
            ).decode("ascii"),
        },
        {
            "kind": "message",
            "subject": "raw.sens.capsense",
            "server_timestamp": 3.0,
            "stream_sequence": 2,
            "payload_b64": "AA==",
        },
    ]
    with gzip.open(chunk, "wt", encoding="utf-8") as output:
        for record in records:
            output.write(json.dumps(record) + "\n")

    destination = tmp_path / "report.json"
    assert main([
        "--raw-dir", str(raw_dir),
        "--from", "1970-01-01T00:00:00Z",
        "--to", "1970-01-01T00:00:10Z",
        "--out", str(destination),
    ]) == 0
    report = json.loads(destination.read_text(encoding="utf-8"))
    assert report["transitions"] == {"left": [], "right": []}
    assert report["final_snapshot"]["algorithm_version"] == ALGORITHM_VERSION


def test_sos_coefficients_match_scipy_when_available():
    scipy = pytest.importorskip("scipy")
    from scipy.signal import butter

    expected = butter(3, [1.0, 10.0], btype="band", fs=25, output="sos")
    for actual, scipy_row in zip(SOS_MOTION, expected.tolist()):
        assert list(actual) == pytest.approx(scipy_row)
