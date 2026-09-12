# Occupancy study recorder

The occupancy-study recorder is a read-only JetStream consumer for deliberately
labeled bed-entry and bed-exit trials. It does not calculate occupancy and is
not connected to HomeKit, Home Assistant, auto-off, alarms, pumps, or any other
control path.

## Evidence retained

The durable consumer archives these original CBOR payloads without decoding or
normalizing them:

- `raw.sens.capsense`
- `raw.sens.piezo`
- `raw.sens.lps` when firmware publishes it
- `raw.sens.health`
- `raw.frz.health`

Each private gzip JSONL chunk preserves the NATS stream sequence, server
timestamp, receipt timestamp, subject, headers, delivery count, and base64
payload. Chunks are written atomically before their JetStream messages are
acknowledged. Redelivery can repeat a stream sequence after a crash; analysis
must deduplicate by `stream_sequence`.

The default archive is
`/persistent/sleepypod-data/occupancy-study/raw`. It retains 10 days and is
also capped at 4 GiB, deleting oldest complete chunks first. The firmware's
`raw` stream remains unchanged and continues to keep its own 24-hour window.

## Ground-truth labels

Record event labels from an operator timestamp:

```bash
sp-occupancy-study label contact_start --side left \
  --at 2026-09-12T07:30:00-07:00 --confidence high
sp-occupancy-study label stable_on --side left \
  --at 2026-09-12T07:30:08-07:00
sp-occupancy-study label exit_start --side left \
  --at 2026-09-12T07:45:00-07:00
sp-occupancy-study label stable_off --side left \
  --at 2026-09-12T07:45:06-07:00
```

Use `--earliest` and `--latest` when a boundary is uncertain. Supported phases
are `empty_start`, `contact_start`, `stable_on`, `movement`, `edge_sit`,
`exit_start`, `stable_off`, `nuisance`, and `note`.

## Status and export

```bash
sp-occupancy-study status
sp-occupancy-study status --check --max-stale-seconds 900
sp-occupancy-study export \
  --from 2026-09-12T07:00:00-07:00 \
  --to 2026-09-12T09:00:00-07:00 \
  --out /tmp/occupancy-study-20260912.tar
```

An export contains checksum-listed raw chunks, labels, and matching rows from
vitals, vitals quality, movement, capSense windows, piezo presence decisions,
transition snapshots, and sleep records. Preserve channel names as published;
the physical side mapping must be established by the labeled trial.

Full-scale values such as `0x7fffffff` remain in the source payload. Offline
analysis must mark them invalid and preserve them as gaps rather than replacing
them with zero or using them in feature calculations.

## Suggested labeled trial

Keep the bed empty for at least five minutes, then label `contact_start`,
`stable_on`, ten minutes of quiet lying, ordinary `movement`, `edge_sit`,
`exit_start`, and `stable_off`. Repeat on the other side. If practical, add a
both-sides interval, an opposite-side sit, bedding or object placement as a
`nuisance`, and pump-active periods. Labels describe evidence only; they do not
change the live detector.

For a time-bounded field study, set `OCCUPANCY_STUDY_END_AT` in
`/etc/sleepypod/modules/occupancy-study-recorder.env` to an ISO-8601 timestamp.
The service exits successfully at that time and remains stopped because its
restart policy is `on-failure`.
