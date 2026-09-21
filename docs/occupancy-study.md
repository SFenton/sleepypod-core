# Occupancy study recorder

The occupancy-study recorder is a read-only JetStream consumer for deliberately
labeled bed-entry and bed-exit trials. It does not calculate occupancy or
control HomeKit, auto-off, alarms, pumps, or any other behavior.

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

## Shadow occupancy replay

The study includes a non-controlling candidate detector for named-channel
`capSense` data. It uses an explicit empty-bed baseline, positive-only
multi-channel load evidence, raw-unit scale floors, entry/exit dwell, slow
empty-state baseline adaptation, directional load/unload velocity, and
paired-side comparison to flag cross-bed coupling. A threshold crossing must
follow a meaningful load impulse within the preceding minute; slow post-exit
mattress recovery or cross-side creep cannot create a new load. An
inner-zone-only load on an empty side is classified as likely encroachment while
the opposite side is occupied, rather than immediately creating a second
occupant. It does not feed HomeKit, sleep sessions, auto-off, alarms, or hardware
control.

The shadow `occupied` boolean means that capacitance supports a sustained
surface load. It does **not** establish that the load is a person. Decisions
therefore report `classification: loaded_unconfirmed`; operator labels and
future independently validated sensing are required before promoting that state
to person occupancy. `person_present` is consequently `null` for an
unconfirmed load, `false` for empty or classified encroachment, and is never set
to `true` by the current candidate. Current piezo presence and derived vitals
are not accepted as confirmation because labeled nuisance loads can produce
plausible values.

Choose a known-empty baseline window and replay a later interval:

```bash
sp-occupancy-study analyze \
  --baseline-from 2026-09-12T19:30:00-07:00 \
  --baseline-to 2026-09-12T19:45:00-07:00 \
  --from 2026-09-12T19:45:00-07:00 \
  --to 2026-09-13T10:00:00-07:00 \
  --include-decisions
```

The JSON report contains the initial and adapted baselines, state transitions,
transition scores, coupling flags, and final shadow state. With
`--include-decisions`, it also contains every per-side score and decision reason.
Baseline windows must be operator-confirmed or otherwise independently
established as empty; the analyzer deliberately does not treat a low-variance
window as proof of an empty bed.

## Continuous adaptive runtime

The optional `sleepypod-adaptive-occupancy.service` runs the same detector
continuously from the downsampled `cap_sense_frames` table. It writes one
current-state row per side to `adaptive_occupancy_state` and an atomic detector
checkpoint to
`/persistent/sleepypod-data/adaptive-occupancy-checkpoint.json`. The checkpoint
preserves adapted baselines, dwell candidates, recent velocity, and coupling
state across restarts.

The first start requires an operator-confirmed empty window in
`/etc/sleepypod/modules/adaptive-occupancy.env`:

```ini
ADAPTIVE_OCCUPANCY_BASELINE_FROM=2026-09-12T19:30:00-07:00
ADAPTIVE_OCCUPANCY_BASELINE_TO=2026-09-12T19:45:00-07:00
```

The service replays from that window through the newest retained capSense
frame, saves a checkpoint, and then tails new five-second frames. Later starts
restore the checkpoint and do not need the original baseline rows. If neither a
valid checkpoint nor an explicit baseline window is available, the service
fails closed instead of guessing that a quiet or calibrated bed was empty.

After a detected entry, a load that remains below the independent-entry score
on only one channel for 15 continuous minutes is cleared. This handles
post-exit mattress rebound without reacting to the much shorter weak
single-channel intervals observed during occupied nights. Any renewed
multi-channel load, independent-strength score, or entry velocity resets the
guard.

The independent-entry score bypass applies only when velocity cannot be
measured after a stream gap. During continuous data, every new entry still
requires a recent load impulse, so slow thermal or mechanical rebound cannot
re-enter merely by drifting above the independent score.

When MQTT is enabled, the core publishes retained production and comparison
signals:

- `state/occupancy/<side>/legacy` contains the previous movement and
  calibrated-level result for comparison.
- `state/occupancy/<side>/adaptive` contains adaptive load state,
  classification, nullable person presence, scores, baseline, and transition
  timestamps.
- `availability/adaptive-occupancy` is `online` only while both adaptive
  sensor sample timestamps are no more than 60 seconds old. Database write
  time is not used, so replaying a backlog cannot make historical evidence
  appear live.

Home Assistant discovery creates the primary occupancy binary sensor, a legacy
comparison binary sensor, an explicitly named adaptive-load comparison sensor,
and an adaptive classification enum sensor for each side. The primary and
adaptive binary sensors intentionally share the fresh adaptive-load topic and
both represent sustained surface load, not confirmed person presence. If that
topic is stale, both become unavailable rather than publishing a potentially
misleading absence; the legacy comparison entity remains separate.

Fresh adaptive state is also the shared production source used by HomeKit, the
occupancy API and UI, and auto-off. If the adaptive row is missing, stale by
more than 60 seconds, or unreadable, the shared source conservatively reports
the legacy occupied value but marks occupancy unavailable. This keeps HomeKit
useful while forcing absence-triggered behavior such as auto-off to stand down.
The Python sleep-session detector remains independent and continues to process
its own raw sensor stream.

## Fused occupancy shadow

The core also evaluates a non-controlling, versioned fused decision per side.
It is deliberately separate from the production primary entities and every
existing consumer while the transition-certified clear logic is validated.

The pure state machine reports:

- `occupied` from fresh adaptive load or a credible same-side return;
- `clear` from fresh adaptive clear or a maintained exit certificate;
- `unavailable` when current adaptive evidence cannot support a decision.

The initial certificate seeds are a three-minute robust loaded baseline,
adaptive score collapse to at most 40% of that baseline, loaded-channel
collapse to at most one, piezo energy collapse to at most 25% of its baseline,
both deployed piezo exit features below threshold, and 30 seconds of
continuous confirmation. Pump-coupled samples, source gaps,
stale evidence, process restart, material cap rebound, or a new load impulse
invalidate the candidate or certificate. These values are shadow-study
parameters, not promoted production thresholds.

The piezo processor records its guarded pump mode on every presence decision,
including while the existing detector remains in its present hysteresis state,
so the shadow cannot interpret an active-pump exit window as pump-safe.

MQTT publishes:

- `state/occupancy/<side>/fused-shadow` — plain, non-retained `ON` / `OFF`
  heartbeat;
- `availability/occupancy/<side>/fused-shadow` — retained per-side
  `online` / `offline`;
- `state/occupancy/<side>/fused-shadow/decision` — retained, low-churn
  classification, reason, provenance, and certificate diagnostics.

Home Assistant discovery marks both shadow entities diagnostic, disabled, and
hidden by default. The binary sensor uses `expire_after: 3` with a one-second
heartbeat and combines the Pod LWT with per-side decision availability. The
existing primary, adaptive, legacy, HomeKit, API/web, and auto-off contracts
remain unchanged.

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
