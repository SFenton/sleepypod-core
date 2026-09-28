"""Replay occupancy-study recorder chunks through the EoL detector."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import struct
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .eol_occupancy import Decision, EolPair


def parse_iso_timestamp(value: str) -> float:
    """Parse an explicit, timezone-aware ISO-8601 command-line timestamp."""

    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return parsed.timestamp()


def replay(
    raw_dir: Path,
    start: float,
    end: float,
    decoder: Callable[[bytes], object],
) -> dict:
    """Replay archived messages in server-time order using an injected CBOR decoder."""

    if start > end:
        raise ValueError("--from must not be after --to")
    pair = EolPair()
    transitions: Dict[str, List[dict]] = {"left": [], "right": []}
    prior_states: Dict[str, Optional[str]] = {"left": None, "right": None}
    last_sequence: Optional[int] = None

    for timestamp, sequence, subject, payload in _archived_messages(raw_dir):
        if last_sequence is not None and sequence <= last_sequence:
            continue
        last_sequence = sequence
        if timestamp < start or timestamp > end:
            continue
        record = decoder(payload)
        decisions = _feed_record(pair, timestamp, subject, record)
        if decisions is None:
            continue
        for side, decision in decisions.items():
            if (
                decision.event is not None
                or (
                    prior_states[side] is not None
                    and decision.state != prior_states[side]
                )
            ):
                transitions[side].append(_transition(decision))
            prior_states[side] = decision.state

    return {
        "transitions": transitions,
        "final_snapshot": pair.snapshot(),
    }


def _archived_messages(raw_dir: Path) -> Iterable[Tuple[float, int, str, bytes]]:
    if not raw_dir.is_dir():
        raise ValueError("raw directory does not exist: %s" % raw_dir)
    messages: List[Tuple[float, int, str, bytes]] = []
    for path in sorted(raw_dir.rglob("*.jsonl.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as source:
            for line_number, line in enumerate(source, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(
                        "invalid JSON in %s line %d" % (path, line_number)
                    ) from exc
                if not isinstance(value, Mapping) or value.get("kind") != "message":
                    continue
                messages.append(_archived_message(value, path, line_number))
    return iter(sorted(messages, key=lambda item: (item[0], item[1])))


def _archived_message(
    value: Mapping[str, object],
    path: Path,
    line_number: int,
) -> Tuple[float, int, str, bytes]:
    try:
        timestamp = float(value["server_timestamp"])
        sequence = int(value["stream_sequence"])
        subject = str(value["subject"])
        encoded = str(value["payload_b64"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(
            "malformed message in %s line %d" % (path, line_number)
        ) from exc
    if sequence < 0:
        raise ValueError("stream sequence must not be negative")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError(
            "invalid payload_b64 in %s line %d" % (path, line_number)
        ) from exc
    return timestamp, sequence, subject, payload


def _feed_record(
    pair: EolPair,
    timestamp: float,
    subject: str,
    record: object,
) -> Optional[Dict[str, Decision]]:
    if not isinstance(record, Mapping):
        raise ValueError("CBOR payload must decode to a map")
    if subject == "raw.sens.capsense":
        if record.get("type") != "capSense":
            return None
        left, left_good = capsense_side(record, "left")
        right, right_good = capsense_side(record, "right")
        return pair.update_cap(
            timestamp,
            left,
            right,
            left_good=left_good,
            right_good=right_good,
        )
    if subject == "raw.sens.piezo":
        if record.get("type") != "piezo-dual":
            return None
        pair.update_piezo_raw(
            timestamp,
            int32_samples(record.get("left1"), "left1"),
            int32_samples(record.get("right1"), "right1"),
        )
    return None


def capsense_side(
    record: Mapping[str, object],
    side: str,
) -> Tuple[Sequence[float], bool]:
    source = record.get(side)
    if not isinstance(source, Mapping):
        raise ValueError("capSense payload is missing %s" % side)
    try:
        values = [float(source[channel]) for channel in ("out", "cen", "in")]
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("capSense %s channels are malformed" % side) from exc
    return values, source.get("status") == "good"


def int32_samples(value: object, name: str) -> Sequence[int]:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise ValueError("piezo %s must be a byte string" % name)
    raw = bytes(value)
    if len(raw) % 4:
        raise ValueError("piezo %s has a partial int32 sample" % name)
    if not raw:
        raise ValueError("piezo %s is empty" % name)
    return struct.unpack("<%di" % (len(raw) // 4), raw)


def _transition(decision: Decision) -> dict:
    return {
        "timestamp": decision.timestamp,
        "occupied": decision.occupied,
        "confirmed": decision.confirmed,
        "state": decision.state,
        "event": decision.event,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the replay command, importing optional CBOR support only on use."""

    parser = argparse.ArgumentParser(
        description="Replay occupancy-study chunks through the EoL detector."
    )
    parser.add_argument("--raw-dir", required=True, type=Path)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    try:
        import cbor2
    except ImportError:
        parser.error("cbor2 is required to decode occupancy-study payloads")
    try:
        report = replay(
            args.raw_dir,
            parse_iso_timestamp(args.start),
            parse_iso_timestamp(args.end),
            cbor2.loads,
        )
    except ValueError as exc:
        parser.error(str(exc))

    encoded = json.dumps(report, sort_keys=True, separators=(",", ":"))
    if args.out is None:
        print(encoded)
    else:
        args.out.write_text(encoded + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
