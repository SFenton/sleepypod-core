import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.adaptive_occupancy import (
    AdaptiveCapPair,
    AdaptiveCapSide,
    DetectorConfig,
    analyze_database,
)


def _feed_side(detector, samples):
    decisions = []
    for timestamp, values in samples:
        measurement = detector.measure(timestamp, values)
        decisions.append(detector.update(timestamp, measurement))
    return decisions


def test_downward_empty_drift_does_not_read_as_presence():
    detector = AdaptiveCapSide(
        "left",
        [[1400, 1100, 1250]] * 6,
        DetectorConfig(baseline_time_constant_seconds=60),
    )

    decisions = _feed_side(detector, [
        (0, [1400, 1100, 1250]),
        (10, [1320, 1020, 1190]),
        (20, [1310, 1010, 1180]),
        (30, [1300, 1000, 1170]),
    ])

    assert all(not decision.occupied for decision in decisions)
    assert detector.baseline[0] < 1400


def test_slow_upward_drift_cannot_enter_without_recent_load_velocity():
    detector = AdaptiveCapSide(
        "left",
        [[1400, 1100, 1250]] * 6,
        DetectorConfig(
            baseline_time_constant_seconds=100000,
            entry_dwell_seconds=10,
        ),
    )

    decisions = _feed_side(detector, [
        (0, [1400, 1100, 1250]),
        (60, [1450, 1120, 1260]),
        (120, [1500, 1140, 1270]),
        (180, [1550, 1160, 1280]),
        (240, [1600, 1180, 1290]),
        (300, [1650, 1200, 1300]),
        (360, [1700, 1220, 1310]),
        (420, [1750, 1240, 1320]),
        (480, [1800, 1260, 1330]),
    ])

    assert decisions[-1].score >= detector.config.independent_entry_score
    assert decisions[-1].entry_velocity_supported is False
    assert all(not decision.occupied for decision in decisions)


def test_sustained_single_channel_load_enters_but_a_spike_does_not():
    config = DetectorConfig(entry_dwell_seconds=10)
    detector = AdaptiveCapSide("right", [[1700, 1550, 2280]] * 6, config)

    decisions = _feed_side(detector, [
        (0, [1700, 1550, 2280]),
        (5, [1700, 1950, 2280]),
        (7, [1700, 1550, 2280]),
        (20, [1700, 1950, 2280]),
        (25, [1700, 1975, 2280]),
        (30, [1700, 2000, 2280]),
    ])

    assert decisions[2].occupied is False
    assert decisions[-1].occupied is True
    assert decisions[-1].edge_timestamp == 20
    assert decisions[-1].classification == "loaded_unconfirmed"
    assert decisions[-1].person_present is None
    assert decisions[-1].entry_velocity_supported is True


def test_short_real_exit_and_reentry_are_preserved():
    config = DetectorConfig(entry_dwell_seconds=10, exit_dwell_seconds=20)
    detector = AdaptiveCapSide("left", [[1400, 1100, 1250]] * 6, config)
    occupied = [1750, 1650, 1450]
    empty = [1390, 1090, 1240]

    decisions = _feed_side(detector, [
        (0, occupied),
        (10, occupied),
        (20, empty),
        (30, empty),
        (40, empty),
        (50, empty),
        (60, occupied),
        (70, occupied),
    ])

    transitions = [
        (decision.occupied, decision.edge_timestamp)
        for decision in decisions if decision.changed
    ]
    assert transitions == [(True, 0), (False, 20), (True, 60)]


def test_prolonged_weak_single_channel_rebound_exits():
    config = DetectorConfig(
        entry_dwell_seconds=10,
        exit_dwell_seconds=20,
        weak_single_channel_exit_dwell_seconds=900,
    )
    detector = AdaptiveCapSide(
        "right",
        [[1347.5, 1263.8, 2135.8]] * 6,
        config,
    )

    samples = [
        (0, [1347.5, 1263.8, 2135.8]),
        (5, [1612.6, 1312.9, 2002.5]),
        (10, [1562.9, 1389.9, 2029.4]),
        (15, [1623.8, 1388.0, 2047.5]),
    ]
    samples.extend(
        (timestamp, [1800.0, 1225.0, 2050.0])
        for timestamp in range(20, 1001, 5)
    )

    decisions = _feed_side(detector, samples)
    transitions = [
        (decision.occupied, decision.edge_timestamp, decision.reason)
        for decision in decisions if decision.changed
    ]

    assert transitions == [
        (True, 5, "entry"),
        (False, 970, "exit"),
    ]
    assert decisions[-1].classification == "empty"


def test_short_weak_single_channel_interval_does_not_exit():
    config = DetectorConfig(
        entry_dwell_seconds=10,
        exit_dwell_seconds=20,
        weak_single_channel_exit_dwell_seconds=900,
    )
    detector = AdaptiveCapSide(
        "left",
        [[1400, 1100, 1250]] * 6,
        config,
    )
    decisions = _feed_side(detector, [
        (0, [1900, 1650, 1450]),
        (10, [1900, 1650, 1450]),
        (70, [1850, 1100, 1250]),
        (570, [1850, 1100, 1250]),
        (575, [1900, 1650, 1450]),
    ])

    assert decisions[-1].occupied is True
    assert not any(
        decision.changed and not decision.occupied
        for decision in decisions
    )


def test_cross_side_coupling_suppresses_only_the_weaker_entry():
    pair = AdaptiveCapPair(
        [[1400, 1100, 1250]] * 6,
        [[1700, 1550, 2280]] * 6,
        DetectorConfig(entry_dwell_seconds=5),
    )
    pair.update(0, [1400, 1100, 1250], [1700, 1550, 2280])
    first = pair.update(5, [1900, 1650, 1450], [1700, 1900, 2280])
    second = pair.update(10, [1900, 1650, 1450], [1700, 1900, 2280])

    assert first["right"].reason == "coupled_entry_suppressed"
    assert second["left"].occupied is True
    assert second["right"].occupied is False


def test_inner_zone_velocity_is_encroachment_when_peer_is_occupied():
    pair = AdaptiveCapPair(
        [[1400, 1100, 1250]] * 6,
        [[1700, 1550, 2280]] * 6,
        DetectorConfig(entry_dwell_seconds=5),
    )
    pair.update(0, [1400, 1100, 1250], [1700, 1950, 2280])
    pair.update(5, [1400, 1100, 1250], [1700, 1950, 2280])

    encroachment = pair.update(10, [1400, 1100, 1600], [1700, 1950, 2280])
    held = pair.update(15, [1400, 1100, 1650], [1700, 1950, 2280])

    assert encroachment["left"].reason == "inner_zone_encroachment"
    assert encroachment["left"].classification == "inner_zone_encroachment"
    assert encroachment["left"].person_present is False
    assert encroachment["left"].load_velocity_score > 1
    assert held["left"].reason == "inner_zone_encroachment"
    assert held["left"].occupied is False


def test_strong_inner_load_after_a_gap_is_still_encroachment():
    pair = AdaptiveCapPair(
        [[1400, 1100, 1250]] * 6,
        [[1700, 1550, 2280]] * 6,
        DetectorConfig(entry_dwell_seconds=5),
    )
    pair.update(0, [1400, 1100, 1250], [1700, 2050, 2280])
    pair.update(5, [1400, 1100, 1250], [1700, 2050, 2280])

    decision = pair.update(50, [1480, 1100, 2050], [1700, 2050, 2280])

    assert decision["left"].load_velocity_score == 0
    assert decision["left"].reason == "inner_zone_encroachment"
    assert decision["left"].occupied is False


def test_encroachment_stays_latched_through_slow_outer_drift():
    pair = AdaptiveCapPair(
        [[1400, 1100, 1250]] * 6,
        [[1700, 1550, 2280]] * 6,
        DetectorConfig(entry_dwell_seconds=5),
    )
    pair.update(0, [1400, 1100, 1250], [1700, 2050, 2280])
    pair.update(5, [1400, 1100, 1250], [1700, 2050, 2280])
    pair.update(10, [1400, 1100, 1750], [1700, 2050, 2280])

    decisions = [
        pair.update(timestamp, values, [1700, 2050, 2280])["left"]
        for timestamp, values in [
            (15, [1460, 1100, 1750]),
            (20, [1510, 1110, 1720]),
            (25, [1540, 1120, 1700]),
        ]
    ]

    assert all(decision.reason == "inner_zone_encroachment" for decision in decisions)
    assert all(decision.occupied is False for decision in decisions)


def test_recent_peer_exit_extends_dwell_for_coupled_unloading():
    pair = AdaptiveCapPair(
        [[1400, 1100, 1250]] * 6,
        [[1700, 1550, 2280]] * 6,
        DetectorConfig(
            entry_dwell_seconds=5,
            exit_dwell_seconds=10,
            coupled_exit_dwell_seconds=30,
        ),
    )
    loaded_left = [1900, 1650, 1450]
    loaded_right = [1700, 1950, 2280]
    empty_left = [1400, 1100, 1250]
    coupled_right = [1700, 1550, 2280]

    pair.update(0, empty_left, [1700, 1550, 2280])
    pair.update(5, empty_left, loaded_right)
    pair.update(10, empty_left, loaded_right)
    pair.update(15, loaded_left, loaded_right)
    pair.update(20, loaded_left, loaded_right)
    pair.update(25, empty_left, loaded_right)
    pair.update(35, empty_left, loaded_right)
    first_coupled = pair.update(40, empty_left, coupled_right)
    still_coupled = pair.update(60, empty_left, coupled_right)
    recovered = pair.update(65, empty_left, loaded_right)

    assert first_coupled["right"].reason == "coupled_exit_candidate"
    assert still_coupled["right"].occupied is True
    assert recovered["right"].occupied is True


def test_analyze_database_replays_without_changing_production(tmp_path):
    path = tmp_path / "biometrics.db"
    connection = sqlite3.connect(path)
    connection.execute(
        """CREATE TABLE cap_sense_frames (
             side TEXT NOT NULL,
             timestamp INTEGER NOT NULL,
             zones TEXT
           )"""
    )
    rows = []
    for timestamp in range(0, 31, 5):
        rows.extend([
            ("left", timestamp, json.dumps([1400, 1100, 1250])),
            ("right", timestamp, json.dumps([1700, 1550, 2280])),
        ])
    for timestamp in range(35, 66, 5):
        rows.extend([
            ("left", timestamp, json.dumps([1800, 1650, 1450])),
            ("right", timestamp, json.dumps([1700, 1550, 2280])),
        ])
    connection.executemany(
        "INSERT INTO cap_sense_frames VALUES (?, ?, ?)",
        rows,
    )
    connection.commit()

    report = analyze_database(connection, 35, 65, 0, 30, include_decisions=True)

    assert report["production_behavior_changed"] is False
    assert report["final_state"] == {"left": True, "right": False}
    assert report["final_person_present"] == {"left": None, "right": False}
    assert [
        (transition["side"], transition["occupied"], transition["edge_timestamp"])
        for transition in report["transitions"]
    ] == [("left", True, 35.0)]
    assert report["transitions"][0]["classification"] == "loaded_unconfirmed"
    assert len(report["decision_trace"]) == 14
