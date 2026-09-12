#!/usr/bin/env python3
"""Bounded, read-only evidence recorder for SleepyPod occupancy studies."""

import argparse
import asyncio
import base64
import fcntl
import gzip
import hashlib
import json
import os
import re
import signal
import sqlite3
import tarfile
import tempfile
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

FORMAT_VERSION = 1
STREAM_NAME = "raw"
DURABLE_NAME = "sleepypod_occupancy_study_v1"
CAPTURE_SUBJECTS = (
    "raw.sens.capsense",
    "raw.sens.piezo",
    "raw.sens.lps",
    "raw.sens.health",
    "raw.frz.health",
)
DEFAULT_STUDY_DIR = Path("/persistent/sleepypod-data/occupancy-study")
DEFAULT_DB = Path("/persistent/sleepypod-data/biometrics.db")
CHUNK_SUFFIX = ".jsonl.gz"
CHUNK_RE = re.compile(
    r"^(?P<start>\d{8}T\d{6}\.\d{6}Z)--"
    r"(?P<end>\d{8}T\d{6}\.\d{6}Z)--"
    r"s(?P<first>\d{20})-s(?P<last>\d{20})\.jsonl\.gz$"
)
LABEL_PHASES = (
    "empty_start",
    "contact_start",
    "stable_on",
    "movement",
    "edge_sit",
    "exit_start",
    "stable_off",
    "nuisance",
    "note",
)
SIDES = ("none", "left", "right", "both")
CONFIDENCE_LEVELS = ("low", "medium", "high")


def env_path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name, str(default)))


def env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as exc:
        raise ValueError("%s must be an integer" % name) from exc
    if value <= 0:
        raise ValueError("%s must be greater than zero" % name)
    return value


def utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def compact_utc(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def parse_timestamp(value: Optional[str]) -> float:
    if value is None:
        return time.time()
    try:
        return float(value)
    except ValueError:
        pass
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return parsed.timestamp()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o770)
    temporary = path.with_name(path.name + ".tmp.%d" % os.getpid())
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(str(temporary), flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(str(temporary), str(path))
        fsync_directory(path.parent)
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


@dataclass(frozen=True)
class ArchivedMessage:
    subject: str
    payload: bytes
    headers: Dict[str, object]
    stream_sequence: int
    consumer_sequence: int
    server_timestamp: float
    received_timestamp: float
    deliveries: int


def archive_record(message: ArchivedMessage) -> Dict[str, object]:
    return {
        "kind": "message",
        "subject": message.subject,
        "stream_sequence": message.stream_sequence,
        "consumer_sequence": message.consumer_sequence,
        "server_time": utc_iso(message.server_timestamp),
        "server_timestamp": message.server_timestamp,
        "received_time": utc_iso(message.received_timestamp),
        "received_timestamp": message.received_timestamp,
        "deliveries": message.deliveries,
        "headers": message.headers,
        "payload_b64": base64.b64encode(message.payload).decode("ascii"),
    }


def chunk_name(messages: Sequence[ArchivedMessage]) -> str:
    first = messages[0]
    last = messages[-1]
    return (
        "%s--%s--s%020d-s%020d%s"
        % (
            compact_utc(first.server_timestamp),
            compact_utc(last.server_timestamp),
            first.stream_sequence,
            last.stream_sequence,
            CHUNK_SUFFIX,
        )
    )


def write_chunk(messages: Sequence[ArchivedMessage], archive_dir: Path, gzip_level: int = 1) -> Path:
    if not messages:
        raise ValueError("cannot write an empty chunk")
    ordered = sorted(messages, key=lambda item: item.stream_sequence)
    archive_dir.mkdir(parents=True, exist_ok=True, mode=0o770)
    destination = archive_dir / chunk_name(ordered)
    if destination.exists():
        return destination

    temporary = destination.with_name(destination.name + ".tmp.%d" % os.getpid())
    subject_counts = Counter(message.subject for message in ordered)
    header = {
        "kind": "chunk",
        "format": "sleepypod-occupancy-study",
        "format_version": FORMAT_VERSION,
        "stream": STREAM_NAME,
        "first_stream_sequence": ordered[0].stream_sequence,
        "last_stream_sequence": ordered[-1].stream_sequence,
        "start_time": utc_iso(ordered[0].server_timestamp),
        "end_time": utc_iso(ordered[-1].server_timestamp),
        "message_count": len(ordered),
        "subject_counts": dict(sorted(subject_counts.items())),
    }

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(str(temporary), flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=gzip_level, mtime=0) as zipped:
                zipped.write((json.dumps(header, sort_keys=True) + "\n").encode("utf-8"))
                for message in ordered:
                    line = json.dumps(
                        archive_record(message),
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    zipped.write(line.encode("utf-8") + b"\n")
            raw.flush()
            os.fsync(raw.fileno())
        try:
            os.replace(str(temporary), str(destination))
        except FileExistsError:
            temporary.unlink()
            return destination
        os.utime(destination, (ordered[-1].server_timestamp, ordered[-1].server_timestamp))
        fsync_directory(archive_dir)
        return destination
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def chunk_bounds(path: Path) -> Tuple[float, float]:
    match = CHUNK_RE.match(path.name)
    if not match:
        raise ValueError("invalid occupancy-study chunk name: %s" % path.name)
    start = datetime.strptime(match.group("start"), "%Y%m%dT%H%M%S.%fZ").replace(
        tzinfo=timezone.utc
    )
    end = datetime.strptime(match.group("end"), "%Y%m%dT%H%M%S.%fZ").replace(
        tzinfo=timezone.utc
    )
    return start.timestamp(), end.timestamp()


def archive_files(archive_dir: Path) -> List[Path]:
    if not archive_dir.exists():
        return []
    return sorted(path for path in archive_dir.iterdir() if CHUNK_RE.match(path.name))


def prune_archive(
    archive_dir: Path,
    retention_days: int,
    max_bytes: int,
    now: Optional[float] = None,
) -> Dict[str, int]:
    cutoff = (time.time() if now is None else now) - retention_days * 86400
    files = archive_files(archive_dir)
    removed_files = 0
    removed_bytes = 0

    if archive_dir.exists():
        for path in archive_dir.glob("*.tmp.*"):
            size = path.stat().st_size
            path.unlink()
            removed_files += 1
            removed_bytes += size

    for path in list(files):
        _, end = chunk_bounds(path)
        if end >= cutoff:
            continue
        size = path.stat().st_size
        path.unlink()
        files.remove(path)
        removed_files += 1
        removed_bytes += size

    total = sum(path.stat().st_size for path in files)
    for path in files:
        if total <= max_bytes:
            break
        size = path.stat().st_size
        path.unlink()
        total -= size
        removed_files += 1
        removed_bytes += size

    if archive_dir.exists():
        fsync_directory(archive_dir)
    return {
        "removed_files": removed_files,
        "removed_bytes": removed_bytes,
        "remaining_files": len(archive_files(archive_dir)),
        "remaining_bytes": total,
    }


def append_label(
    labels_path: Path,
    phase: str,
    side: str,
    event_at: float,
    earliest_at: float,
    latest_at: float,
    confidence: str,
    source: str,
    note: Optional[str],
) -> Dict[str, object]:
    if phase not in LABEL_PHASES:
        raise ValueError("unsupported phase: %s" % phase)
    if side not in SIDES:
        raise ValueError("unsupported side: %s" % side)
    if confidence not in CONFIDENCE_LEVELS:
        raise ValueError("unsupported confidence: %s" % confidence)
    if not earliest_at <= event_at <= latest_at:
        raise ValueError("event time must fall within earliest/latest bounds")

    record = {
        "format_version": FORMAT_VERSION,
        "phase": phase,
        "side": side,
        "event_at": event_at,
        "event_time": utc_iso(event_at),
        "earliest_at": earliest_at,
        "earliest_time": utc_iso(earliest_at),
        "latest_at": latest_at,
        "latest_time": utc_iso(latest_at),
        "confidence": confidence,
        "source": source,
        "note": note,
        "recorded_at": time.time(),
    }
    record["recorded_time"] = utc_iso(float(record["recorded_at"]))
    labels_path.parent.mkdir(parents=True, exist_ok=True, mode=0o770)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(str(labels_path), flags, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as output:
        fcntl.flock(output.fileno(), fcntl.LOCK_EX)
        output.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
        output.flush()
        os.fsync(output.fileno())
        fcntl.flock(output.fileno(), fcntl.LOCK_UN)
    return record


def read_labels(labels_path: Path, start: Optional[float] = None, end: Optional[float] = None) -> List[Dict[str, object]]:
    if not labels_path.exists():
        return []
    labels = []
    with labels_path.open("r", encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            record = json.loads(line)
            event_at = float(record["event_at"])
            if start is not None and event_at < start:
                continue
            if end is not None and event_at > end:
                continue
            labels.append(record)
    return labels


def archive_summary(study_dir: Path) -> Dict[str, object]:
    archive_dir = study_dir / "raw"
    files = archive_files(archive_dir)
    labels = read_labels(study_dir / "labels.jsonl")
    total_bytes = sum(path.stat().st_size for path in files)
    start = end = None
    if files:
        start = chunk_bounds(files[0])[0]
        end = chunk_bounds(files[-1])[1]
    status_path = study_dir / "status.json"
    recorder = None
    if status_path.exists():
        recorder = json.loads(status_path.read_text(encoding="utf-8"))
    return {
        "format_version": FORMAT_VERSION,
        "study_dir": str(study_dir),
        "chunk_count": len(files),
        "archive_bytes": total_bytes,
        "archive_start": start,
        "archive_start_time": utc_iso(start) if start is not None else None,
        "archive_end": end,
        "archive_end_time": utc_iso(end) if end is not None else None,
        "archive_age_seconds": max(0.0, time.time() - end) if end is not None else None,
        "label_count": len(labels),
        "latest_label": labels[-1] if labels else None,
        "recorder": recorder,
    }


TELEMETRY_QUERIES = (
    ("vitals", "timestamp BETWEEN ? AND ?", "timestamp"),
    ("vitals_quality", "timestamp BETWEEN ? AND ?", "timestamp"),
    ("movement", "timestamp BETWEEN ? AND ?", "timestamp"),
    ("cap_sense_frames", "timestamp BETWEEN ? AND ?", "timestamp"),
    ("piezo_presence_decisions", "timestamp BETWEEN ? AND ?", "timestamp"),
    (
        "piezo_transition_snapshots",
        "transition_timestamp BETWEEN ? AND ?",
        "transition_timestamp, sample_offset_seconds",
    ),
    (
        "sleep_records",
        "left_bed_at >= ? AND entered_bed_at <= ?",
        "entered_bed_at",
    ),
)


def dump_telemetry(db_path: Path, output_dir: Path, start: float, end: float) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    if not db_path.exists():
        return counts
    connection = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        for table, predicate, order_by in TELEMETRY_QUERIES:
            if table not in tables:
                continue
            rows = connection.execute(
                "SELECT * FROM %s WHERE %s ORDER BY %s" % (table, predicate, order_by),
                (int(start), int(end)),
            )
            path = output_dir / ("%s.jsonl" % table)
            count = 0
            with path.open("w", encoding="utf-8") as output:
                for row in rows:
                    output.write(
                        json.dumps(dict(row), sort_keys=True, separators=(",", ":")) + "\n"
                    )
                    count += 1
            counts[table] = count
    finally:
        connection.close()
    return counts


def export_study(study_dir: Path, db_path: Path, start: float, end: float, output: Path) -> Dict[str, object]:
    if start >= end:
        raise ValueError("export start must be before export end")
    output.parent.mkdir(parents=True, exist_ok=True)
    lock_path = study_dir / "archive.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o770)
    lock_path.touch(mode=0o600, exist_ok=True)
    with lock_path.open("r") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
        selected = []
        for path in archive_files(study_dir / "raw"):
            chunk_start, chunk_end = chunk_bounds(path)
            if chunk_end >= start and chunk_start <= end:
                selected.append(path)
        labels = read_labels(study_dir / "labels.jsonl", start, end)

        with tempfile.TemporaryDirectory(prefix="sleepypod-occupancy-export-") as temporary:
            temporary_dir = Path(temporary)
            labels_path = temporary_dir / "labels.jsonl"
            with labels_path.open("w", encoding="utf-8") as labels_output:
                for label in labels:
                    labels_output.write(
                        json.dumps(label, sort_keys=True, separators=(",", ":")) + "\n"
                    )
            telemetry_dir = temporary_dir / "telemetry"
            telemetry_dir.mkdir()
            telemetry_counts = dump_telemetry(db_path, telemetry_dir, start, end)
            raw_files = [
                {
                    "name": path.name,
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
                for path in selected
            ]
            manifest = {
                "format": "sleepypod-occupancy-study-export",
                "format_version": FORMAT_VERSION,
                "created_at": utc_iso(time.time()),
                "from": utc_iso(start),
                "to": utc_iso(end),
                "raw_subjects": list(CAPTURE_SUBJECTS),
                "raw_chunks": raw_files,
                "label_count": len(labels),
                "telemetry_rows": telemetry_counts,
            }
            atomic_json(temporary_dir / "manifest.json", manifest)
            with tarfile.open(output, mode="w") as bundle:
                bundle.add(temporary_dir / "manifest.json", arcname="manifest.json")
                bundle.add(labels_path, arcname="labels.jsonl")
                for path in selected:
                    bundle.add(path, arcname="raw/%s" % path.name)
                for path in sorted(telemetry_dir.iterdir()):
                    bundle.add(path, arcname="telemetry/%s" % path.name)
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    return manifest


def freeze_message(message) -> ArchivedMessage:
    metadata = message.metadata
    timestamp = metadata.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return ArchivedMessage(
        subject=message.subject,
        payload=bytes(message.data),
        headers=dict(message.headers or {}),
        stream_sequence=metadata.sequence.stream,
        consumer_sequence=metadata.sequence.consumer,
        server_timestamp=timestamp.timestamp(),
        received_timestamp=time.time(),
        deliveries=metadata.num_delivered,
    )


def validate_consumer_config(config) -> None:
    actual = tuple(config.filter_subjects or ())
    if len(actual) != len(CAPTURE_SUBJECTS) or sorted(actual) != sorted(CAPTURE_SUBJECTS):
        raise RuntimeError(
            "durable consumer %s has unexpected filters %r; expected %r"
            % (DURABLE_NAME, actual, CAPTURE_SUBJECTS)
        )


async def persist_and_ack(messages, records, archive_dir: Path, lock_path: Path, connection) -> Path:
    with lock_path.open("r") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        path = await asyncio.to_thread(write_chunk, records, archive_dir)
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    for message in messages:
        await message.ack()
    await connection.flush()
    return path


async def run_recorder(study_dir: Path) -> None:
    import nats
    from nats.js.api import AckPolicy, ConsumerConfig, DeliverPolicy, ReplayPolicy
    from nats.js.errors import NotFoundError

    archive_dir = study_dir / "raw"
    archive_dir.mkdir(parents=True, exist_ok=True, mode=0o770)
    lock_path = study_dir / "archive.lock"
    lock_path.touch(mode=0o600, exist_ok=True)
    retention_days = env_int("OCCUPANCY_STUDY_RETENTION_DAYS", 10)
    max_bytes = env_int("OCCUPANCY_STUDY_MAX_BYTES", 4 * 1024 * 1024 * 1024)
    chunk_bytes = env_int("OCCUPANCY_STUDY_CHUNK_BYTES", 8 * 1024 * 1024)
    chunk_seconds = env_int("OCCUPANCY_STUDY_CHUNK_SECONDS", 300)
    chunk_messages = env_int("OCCUPANCY_STUDY_CHUNK_MESSAGES", 4096)
    ack_wait_seconds = max(900, chunk_seconds * 3)
    end_at_value = os.environ.get("OCCUPANCY_STUDY_END_AT")
    end_at = parse_timestamp(end_at_value) if end_at_value else None

    nc = await nats.connect(
        os.environ.get("OCCUPANCY_STUDY_NATS_URL", "nats://127.0.0.1:4222"),
        name="sleepypod-occupancy-study-recorder",
        connect_timeout=2,
        max_reconnect_attempts=10,
        reconnect_time_wait=2,
    )
    js = nc.jetstream()
    try:
        try:
            info = await js.consumer_info(STREAM_NAME, DURABLE_NAME)
            validate_consumer_config(info.config)
        except NotFoundError:
            pass
        config = ConsumerConfig(
            durable_name=DURABLE_NAME,
            deliver_policy=DeliverPolicy.ALL,
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=ack_wait_seconds,
            max_ack_pending=8192,
            filter_subjects=list(CAPTURE_SUBJECTS),
            replay_policy=ReplayPolicy.INSTANT,
            description="Read-only bounded occupancy-study evidence archive",
        )
        subscription = await js.pull_subscribe(
            CAPTURE_SUBJECTS[0],
            durable=DURABLE_NAME,
            stream=STREAM_NAME,
            config=config,
        )
        shutdown = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, shutdown.set)

        pending_messages = []
        pending_records: List[ArchivedMessage] = []
        pending_bytes = 0
        chunk_started = time.monotonic()
        total_messages = 0
        total_payload_bytes = 0
        last_prune_monotonic = float("-inf")
        last_prune_result = None

        async def flush_pending() -> None:
            nonlocal pending_messages, pending_records, pending_bytes, chunk_started
            nonlocal total_messages, total_payload_bytes
            if not pending_records:
                return
            path = await persist_and_ack(
                pending_messages, pending_records, archive_dir, lock_path, nc
            )
            total_messages += len(pending_records)
            total_payload_bytes += sum(len(record.payload) for record in pending_records)
            last_record = pending_records[-1]
            pending_messages = []
            pending_records = []
            pending_bytes = 0
            chunk_started = time.monotonic()
            now = time.time()
            atomic_json(
                study_dir / "status.json",
                {
                    "format_version": FORMAT_VERSION,
                    "updated_at": utc_iso(now),
                    "updated_timestamp": now,
                    "last_chunk": path.name,
                    "last_stream_sequence": last_record.stream_sequence,
                    "last_server_time": utc_iso(last_record.server_timestamp),
                    "last_server_timestamp": last_record.server_timestamp,
                    "archived_messages_since_start": total_messages,
                    "archived_payload_bytes_since_start": total_payload_bytes,
                    "retention_days": retention_days,
                    "max_bytes": max_bytes,
                    "end_at": end_at,
                    "end_time": utc_iso(end_at) if end_at is not None else None,
                    "last_prune": last_prune_result,
                },
            )

        while not shutdown.is_set():
            if end_at is not None and time.time() >= end_at:
                break
            try:
                fetched = await subscription.fetch(batch=256, timeout=5)
            except nats.errors.TimeoutError:
                fetched = []
            for message in fetched:
                record = freeze_message(message)
                pending_messages.append(message)
                pending_records.append(record)
                pending_bytes += len(record.payload)
            if time.monotonic() - last_prune_monotonic >= 3600:
                with lock_path.open("r") as lock:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                    last_prune_result = await asyncio.to_thread(
                        prune_archive, archive_dir, retention_days, max_bytes
                    )
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                last_prune_result["at"] = utc_iso(time.time())
                last_prune_monotonic = time.monotonic()
            elapsed = time.monotonic() - chunk_started
            if pending_records and (
                pending_bytes >= chunk_bytes
                or len(pending_records) >= chunk_messages
                or elapsed >= chunk_seconds
            ):
                await flush_pending()
        await flush_pending()
    finally:
        await nc.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("record", help="run the durable JetStream recorder")

    status_parser = subparsers.add_parser("status", help="show archive and label status")
    status_parser.add_argument("--json", action="store_true")
    status_parser.add_argument("--check", action="store_true")
    status_parser.add_argument("--max-stale-seconds", type=int, default=900)

    label_parser = subparsers.add_parser("label", help="append a ground-truth event label")
    label_parser.add_argument("phase", choices=LABEL_PHASES)
    label_parser.add_argument("--side", choices=SIDES, default="none")
    label_parser.add_argument("--at")
    label_parser.add_argument("--earliest")
    label_parser.add_argument("--latest")
    label_parser.add_argument("--confidence", choices=CONFIDENCE_LEVELS, default="high")
    label_parser.add_argument("--source", default="operator")
    label_parser.add_argument("--note")

    export_parser = subparsers.add_parser("export", help="export raw chunks, labels, and telemetry")
    export_parser.add_argument("--from", dest="start", required=True)
    export_parser.add_argument("--to", dest="end", required=True)
    export_parser.add_argument("--out", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    study_dir = env_path("OCCUPANCY_STUDY_DIR", DEFAULT_STUDY_DIR)
    db_path = env_path("BIOMETRICS_DATABASE_URL", DEFAULT_DB)
    if str(db_path).startswith("file:"):
        db_path = Path(str(db_path)[5:])

    if args.command == "record":
        asyncio.run(run_recorder(study_dir))
        return 0
    if args.command == "status":
        summary = archive_summary(study_dir)
        if args.json:
            print(json.dumps(summary, sort_keys=True))
        else:
            print("study directory: %s" % summary["study_dir"])
            print("raw chunks:      %d" % summary["chunk_count"])
            print("archive bytes:   %d" % summary["archive_bytes"])
            print("archive range:   %s to %s" % (
                summary["archive_start_time"] or "none",
                summary["archive_end_time"] or "none",
            ))
            print("archive age:     %s" % (
                "%.1f seconds" % summary["archive_age_seconds"]
                if summary["archive_age_seconds"] is not None else "no data"
            ))
            print("labels:          %d" % summary["label_count"])
        age = summary["archive_age_seconds"]
        if args.check and (age is None or age > args.max_stale_seconds):
            return 2
        return 0
    if args.command == "label":
        event_at = parse_timestamp(args.at)
        earliest_at = parse_timestamp(args.earliest) if args.earliest else event_at
        latest_at = parse_timestamp(args.latest) if args.latest else event_at
        record = append_label(
            study_dir / "labels.jsonl",
            args.phase,
            args.side,
            event_at,
            earliest_at,
            latest_at,
            args.confidence,
            args.source,
            args.note,
        )
        print(json.dumps(record, sort_keys=True))
        return 0
    if args.command == "export":
        manifest = export_study(
            study_dir,
            db_path,
            parse_timestamp(args.start),
            parse_timestamp(args.end),
            Path(args.out),
        )
        print(json.dumps(manifest, sort_keys=True))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
