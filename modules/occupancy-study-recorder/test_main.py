import asyncio
import gzip
import json
import os
import sqlite3
import tarfile
from pathlib import Path

import pytest

from main import (
    ArchivedMessage,
    CAPTURE_SUBJECTS,
    append_label,
    archive_summary,
    chunk_bounds,
    export_study,
    freeze_message,
    parse_timestamp,
    persist_and_ack,
    prune_archive,
    validate_consumer_config,
    write_chunk,
)


def message(sequence, timestamp, subject="raw.sens.piezo", payload=b"payload"):
    return ArchivedMessage(
        subject=subject,
        payload=payload,
        headers={},
        stream_sequence=sequence,
        consumer_sequence=sequence,
        server_timestamp=timestamp,
        received_timestamp=timestamp + 0.25,
        deliveries=1,
    )


def test_write_chunk_preserves_payload_and_sequence(tmp_path):
    path = write_chunk(
        [
            message(11, 1_700_000_000.0, payload=b"\x00\x01"),
            message(12, 1_700_000_001.0, subject="raw.sens.capsense"),
        ],
        tmp_path,
    )
    assert path.is_file()
    assert path.stat().st_mode & 0o777 == 0o600
    assert chunk_bounds(path) == (1_700_000_000.0, 1_700_000_001.0)
    with gzip.open(path, "rt", encoding="utf-8") as source:
        rows = [json.loads(line) for line in source]
    assert rows[0]["message_count"] == 2
    assert rows[0]["subject_counts"] == {
        "raw.sens.capsense": 1,
        "raw.sens.piezo": 1,
    }
    assert rows[1]["payload_b64"] == "AAE="
    assert rows[2]["stream_sequence"] == 12


def test_write_chunk_reuses_identical_sequence_range(tmp_path):
    first = write_chunk([message(1, 1_700_000_000.0)], tmp_path)
    second = write_chunk(
        [message(1, 1_700_000_000.0, payload=b"redelivered")],
        tmp_path,
    )
    assert first == second
    assert len(list(tmp_path.iterdir())) == 1


def test_prune_archive_enforces_age_then_size(tmp_path):
    stale_partial = tmp_path / "stale.jsonl.gz.tmp.123"
    stale_partial.write_bytes(b"partial")
    old = write_chunk([message(1, 1_700_000_000.0, payload=b"a" * 2000)], tmp_path)
    middle = write_chunk([message(2, 1_700_086_400.0, payload=b"b" * 2000)], tmp_path)
    recent = write_chunk([message(3, 1_700_172_800.0, payload=b"c" * 2000)], tmp_path)
    max_bytes = old.stat().st_size + middle.stat().st_size + recent.stat().st_size
    result = prune_archive(
        tmp_path,
        retention_days=2,
        max_bytes=max_bytes,
        now=1_700_172_800.0,
    )
    assert old.exists()
    assert middle.exists()
    assert recent.exists()
    assert not stale_partial.exists()
    assert result["removed_files"] == 1

    result = prune_archive(
        tmp_path,
        retention_days=1,
        max_bytes=recent.stat().st_size,
        now=1_700_172_801.0,
    )
    assert not old.exists()
    assert not middle.exists()
    assert recent.exists()
    assert result["remaining_files"] == 1


def test_append_label_preserves_uncertainty_bounds(tmp_path):
    path = tmp_path / "labels.jsonl"
    record = append_label(
        path,
        "contact_start",
        "left",
        1_700_000_002.0,
        1_700_000_000.0,
        1_700_000_004.0,
        "medium",
        "operator",
        "sat on bed",
    )
    assert record["earliest_at"] == 1_700_000_000.0
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["phase"] == "contact_start"
    assert stored["side"] == "left"


def test_append_label_rejects_inverted_bounds(tmp_path):
    with pytest.raises(ValueError, match="within"):
        append_label(
            tmp_path / "labels.jsonl",
            "contact_start",
            "left",
            10,
            11,
            12,
            "high",
            "operator",
            None,
        )


def test_parse_timestamp_requires_timezone():
    assert parse_timestamp("2023-11-14T22:13:20Z") == 1_700_000_000.0
    with pytest.raises(ValueError, match="timezone"):
        parse_timestamp("2023-11-14T22:13:20")


def make_biometrics_db(path: Path):
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE piezo_presence_decisions "
        "(id INTEGER, timestamp INTEGER, side TEXT, present INTEGER)"
    )
    connection.execute(
        "INSERT INTO piezo_presence_decisions VALUES (1, 1700000001, 'left', 1)"
    )
    connection.execute(
        "INSERT INTO piezo_presence_decisions VALUES (2, 1700001000, 'left', 0)"
    )
    connection.commit()
    connection.close()


def test_export_bundles_overlapping_raw_labels_and_telemetry(tmp_path):
    study_dir = tmp_path / "study"
    raw_dir = study_dir / "raw"
    raw_dir.mkdir(parents=True)
    included = write_chunk([message(1, 1_700_000_001.0)], raw_dir)
    write_chunk([message(2, 1_700_001_000.0)], raw_dir)
    append_label(
        study_dir / "labels.jsonl",
        "stable_on",
        "left",
        1_700_000_002.0,
        1_700_000_002.0,
        1_700_000_002.0,
        "high",
        "operator",
        None,
    )
    db_path = tmp_path / "biometrics.db"
    make_biometrics_db(db_path)
    output = tmp_path / "study.tar"
    manifest = export_study(
        study_dir,
        db_path,
        1_700_000_000.0,
        1_700_000_010.0,
        output,
    )
    assert manifest["raw_subjects"] == list(CAPTURE_SUBJECTS)
    assert manifest["raw_chunks"][0]["name"] == included.name
    assert manifest["telemetry_rows"]["piezo_presence_decisions"] == 1
    with tarfile.open(output) as bundle:
        names = bundle.getnames()
        assert "manifest.json" in names
        assert "labels.jsonl" in names
        assert "raw/%s" % included.name in names
        assert "telemetry/piezo_presence_decisions.jsonl" in names


def test_archive_summary_reports_freshness(tmp_path, monkeypatch):
    study_dir = tmp_path / "study"
    raw_dir = study_dir / "raw"
    raw_dir.mkdir(parents=True)
    write_chunk([message(1, 1_700_000_000.0)], raw_dir)
    monkeypatch.setattr("main.time.time", lambda: 1_700_000_010.0)
    summary = archive_summary(study_dir)
    assert summary["chunk_count"] == 1
    assert summary["archive_age_seconds"] == 10.0


def test_validate_consumer_config_ignores_filter_order():
    config = type("Config", (), {"filter_subjects": list(reversed(CAPTURE_SUBJECTS))})()
    validate_consumer_config(config)


def test_validate_consumer_config_rejects_filter_change():
    config = type("Config", (), {"filter_subjects": ["raw.sens.piezo"]})()
    with pytest.raises(RuntimeError, match="unexpected filters"):
        validate_consumer_config(config)


def test_freeze_message_preserves_jetstream_metadata(monkeypatch):
    sequence = type("Sequence", (), {"stream": 44, "consumer": 7})()
    timestamp = type(
        "Timestamp",
        (),
        {
            "tzinfo": None,
            "replace": lambda self, **kwargs: self,
            "timestamp": lambda self: 1_700_000_000.5,
        },
    )()
    metadata = type(
        "Metadata",
        (),
        {"sequence": sequence, "timestamp": timestamp, "num_delivered": 2},
    )()
    raw = type(
        "Message",
        (),
        {
            "metadata": metadata,
            "subject": "raw.sens.piezo",
            "data": b"\x01\x02",
            "headers": {"x-test": "yes"},
        },
    )()
    monkeypatch.setattr("main.time.time", lambda: 1_700_000_001.0)
    frozen = freeze_message(raw)
    assert frozen.stream_sequence == 44
    assert frozen.consumer_sequence == 7
    assert frozen.deliveries == 2
    assert frozen.payload == b"\x01\x02"


def test_persist_and_ack_never_acks_before_durable_write(tmp_path, monkeypatch):
    events = []

    def fake_write(records, archive_dir):
        events.append("write")
        path = archive_dir / "chunk.jsonl.gz"
        path.write_bytes(b"durable")
        return path

    class FakeMessage:
        async def ack(self):
            events.append("ack")

    class FakeConnection:
        async def flush(self):
            events.append("flush")

    lock_path = tmp_path / "archive.lock"
    lock_path.touch()
    monkeypatch.setattr("main.write_chunk", fake_write)
    asyncio.run(
        persist_and_ack(
            [FakeMessage()],
            [message(1, 1_700_000_000.0)],
            tmp_path,
            lock_path,
            FakeConnection(),
        )
    )
    assert events == ["write", "ack", "flush"]


def test_persist_failure_does_not_ack(tmp_path, monkeypatch):
    events = []

    def fail_write(records, archive_dir):
        raise OSError("disk full")

    class FakeMessage:
        async def ack(self):
            events.append("ack")

    class FakeConnection:
        async def flush(self):
            events.append("flush")

    lock_path = tmp_path / "archive.lock"
    lock_path.touch()
    monkeypatch.setattr("main.write_chunk", fail_write)
    with pytest.raises(OSError, match="disk full"):
        asyncio.run(
            persist_and_ack(
                [FakeMessage()],
                [message(1, 1_700_000_000.0)],
                tmp_path,
                lock_path,
                FakeConnection(),
            )
        )
    assert events == []
