#!/usr/bin/env python3
"""
SleepyPod cover-buttons module.

Tails /persistent/*.RAW for `buttonEvent` CBOR records emitted by the TTC
cover (top/middle/bottom buttons on each side) and logs each press to the
systemd journal. If RAW button records are unavailable, tails frank.service
button logs and posts them to SleepyPod Core's local cover-button dispatcher.
No biometrics-data writes — only the standard system_health lifecycle markers
(start / fatal / stopped) that match the other Python sidecars.

Wire schema (sparse — only sides/buttons that fired are present):

    { "type": "buttonEvent", "ts": 1777357840,
      "left":  { "top": 1, "bottom": 1 },
      "right": { "top": 1 } }
"""

import json
import logging
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.raw_follower import RawFileFollower

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
SLEEPYPOD_DB = Path(os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").replace("file:", ""))
COVER_BUTTON_DISPATCH_URL = os.environ.get(
    "COVER_BUTTON_DISPATCH_URL",
    "http://127.0.0.1:3000/api/internal/cover-button",
)

VALID_SIDES = ("left", "right")
VALID_BUTTONS = ("top", "middle", "bottom")
SIDE_BY_INDEX = {0: "left", 1: "right"}
BUTTON_BY_INDEX = {0: "top", 1: "middle", 2: "bottom"}
RAW_ACTIVE_SUPPRESS_JOURNAL_SECONDS = 10.0
JOURNAL_DUPLICATE_WINDOW_SECONDS = 0.15
JOURNAL_PROCESSING_EVENT_RE = re.compile(
    r"processing \[button\] side (left|right)\s+\{\s*button:\s*(top|middle|bottom),\s*"
    r"type:\s*short,\s*count:\s*([0-9]+)\s*\}"
)
JOURNAL_BUTTON_EVENT_RE = re.compile(
    r"sent button event s0x([0-9a-fA-F]+)\s+i0x([0-9a-fA-F]+)\s+c0x([0-9a-fA-F]+)"
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [cover-buttons] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shutdown handling
# ---------------------------------------------------------------------------

_shutdown = threading.Event()
_raw_active_until = 0.0
_raw_active_lock = threading.Lock()
_recent_journal_events = {}
_recent_journal_events_lock = threading.Lock()

def _on_signal(signum, frame):
    log.info("Received signal %d, shutting down...", signum)
    _shutdown.set()

signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def report_health(status: str, message: str) -> None:
    """Write module health to sleepypod.db system_health table."""
    try:
        conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
        try:
            with conn:
                conn.execute(
                    """INSERT INTO system_health (component, status, message, last_checked)
                       VALUES ('cover-buttons', ?, ?, ?)
                       ON CONFLICT(component) DO UPDATE SET
                         status=excluded.status,
                         message=excluded.message,
                         last_checked=excluded.last_checked""",
                    (status, message, int(time.time())),
                )
        finally:
            conn.close()
    except Exception as e:
        log.warning("Could not write health status: %s", e)

# ---------------------------------------------------------------------------
# Press extraction
# ---------------------------------------------------------------------------

def mark_raw_active() -> None:
    global _raw_active_until
    with _raw_active_lock:
        _raw_active_until = time.monotonic() + RAW_ACTIVE_SUPPRESS_JOURNAL_SECONDS


def raw_source_is_active() -> bool:
    with _raw_active_lock:
        return time.monotonic() < _raw_active_until


def journal_event_is_duplicate(side: str, button: str, count: int) -> bool:
    key = (side, button, count)
    now = time.monotonic()
    with _recent_journal_events_lock:
        last_seen = _recent_journal_events.get(key)
        _recent_journal_events[key] = now
        for existing_key, seen_at in list(_recent_journal_events.items()):
            if now - seen_at > JOURNAL_DUPLICATE_WINDOW_SECONDS:
                del _recent_journal_events[existing_key]
        return last_seen is not None and now - last_seen <= JOURNAL_DUPLICATE_WINDOW_SECONDS


def iter_presses(record):
    """Yield (side, button, count, ts) tuples from a buttonEvent record.

    Skips malformed records (non-dict records, non-dict side payloads,
    unknown button keys) without raising. Non-buttonEvent records yield
    nothing. Corrupt RAW frames must not tear down the service.
    """
    if not isinstance(record, dict) or record.get("type") != "buttonEvent":
        return
    ts = record.get("ts")
    for side in VALID_SIDES:
        side_payload = record.get(side)
        if side_payload is None:
            continue
        if not isinstance(side_payload, dict):
            log.debug("schema mismatch: %s payload is %s, not dict",
                      side, type(side_payload).__name__)
            continue
        for button, count in side_payload.items():
            if button not in VALID_BUTTONS:
                log.debug("schema mismatch: unknown button key %r on %s",
                          button, side)
                continue
            try:
                count_int = int(count)
            except (TypeError, ValueError):
                log.debug("schema mismatch: non-integer count %r for %s.%s",
                          count, side, button)
                continue
            if count_int <= 0:
                continue
            yield side, button, count_int, ts


def parse_firmware_button_event(line: str):
    """Parse frank.service button log lines into (side, button, count).

    The Pod 5 cover firmware currently emits the only live button signal in
    frank.service as lines such as:

        [TTC] processing [button] side left { button: top, type: short, count: 1 }
        [buttons] sent button event s0x00 i0x02 c0x01
    """
    processing_match = JOURNAL_PROCESSING_EVENT_RE.search(line)
    if processing_match:
        count = int(processing_match.group(3), 10)
        if count <= 0:
            return None
        return processing_match.group(1), processing_match.group(2), count

    match = JOURNAL_BUTTON_EVENT_RE.search(line)
    if not match:
        return None

    side_index = int(match.group(1), 16)
    button_index = int(match.group(2), 16)
    count = int(match.group(3), 16)
    side = SIDE_BY_INDEX.get(side_index)
    button = BUTTON_BY_INDEX.get(button_index)
    if side is None or button is None or count <= 0:
        return None
    return side, button, count


def dispatch_press(side: str, button: str, count: int, ts=None) -> None:
    payload = {"side": side, "button": button, "count": count}
    if ts is not None:
        payload["ts"] = ts

    request = urllib.request.Request(
        COVER_BUTTON_DISPATCH_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            if response.status >= 300:
                log.warning("dispatcher returned HTTP %s for %s", response.status, payload)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log.warning("could not dispatch cover-button press %s: %s", payload, e)


def tail_firmware_button_logs() -> None:
    """Fallback event source when the firmware does not expose button RAW files."""
    command = ["journalctl", "-u", "frank.service", "-f", "-n", "0", "-o", "cat"]
    log.info("Starting frank.service button-log fallback")
    process = None
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        if process.stdout is None:
            raise RuntimeError("journalctl produced no stdout")

        while not _shutdown.is_set():
            line = process.stdout.readline()
            if not line:
                if process.poll() is not None:
                    log.warning("journalctl exited with code %s", process.returncode)
                    return
                time.sleep(0.1)
                continue

            parsed = parse_firmware_button_event(line)
            if not parsed:
                continue
            if raw_source_is_active():
                log.debug("skipping journal button event because RAW source is active")
                continue

            side, button, count = parsed
            if journal_event_is_duplicate(side, button, count):
                continue

            ts = int(time.time())
            log.info("firmware press: side=%s button=%s count=%s ts=%s",
                     side, button, count, ts)
            dispatch_press(side, button, count, ts)
    except FileNotFoundError:
        log.warning("journalctl not found; firmware button-log fallback disabled")
    except Exception as e:
        log.exception("firmware button-log fallback failed: %s", e)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info("Starting cover-buttons (raw_dir=%s dispatch_url=%s)",
             RAW_DATA_DIR, COVER_BUTTON_DISPATCH_URL)

    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0.1)
    journal_thread = threading.Thread(
        target=tail_firmware_button_logs,
        name="frank-button-log-tail",
        daemon=True,
    )
    journal_thread.start()

    report_health("healthy", "cover-buttons started")

    try:
        for record in follower.read_records():
            for side, button, count, ts in iter_presses(record):
                mark_raw_active()
                for _ in range(count):
                    log.info("press: side=%s button=%s count=1 ts=%s",
                             side, button, ts)

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        _shutdown.set()
        log.info("Shutdown complete")

    report_health("down", "cover-buttons stopped")


if __name__ == "__main__":
    main()
