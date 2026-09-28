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
and an adaptive classification enum sensor for each side. The adaptive
comparison entities retain the fresh adaptive-load topic; the primary entity
keeps its existing unique ID while consuming the evidence-of-life decision
described below.

Fresh adaptive state is also the shared production source used by HomeKit, the
occupancy API and UI, and auto-off. If the adaptive row is missing, stale by
more than 60 seconds, or unreadable, the shared source conservatively reports
the legacy occupied value but marks occupancy unavailable. This keeps HomeKit
useful while forcing absence-triggered behavior such as auto-off to stand down.
The Python sleep-session detector remains independent and continues to process
its own raw sensor stream.

## Fused occupancy (comparison)

`fused-occupancy-v2` drove the primary Home Assistant occupancy entities from
2026-09-21 until evidence-of-life replaced it. The core still evaluates it per
side and publishes it on its own comparison topics and entities (below) as
rollback evidence, alongside the adaptive and legacy entities.

The pure state machine reports:

- `occupied` from fresh adaptive load or a credible same-side return;
- `clear` from fresh adaptive clear or a maintained exit certificate;
- `unavailable` when current adaptive evidence cannot support a decision.

`fused-occupancy-v2` supports two certificate paths:

- The sustained path keeps the three-minute robust loaded baseline, adaptive
  score collapse to at most 40% of that baseline, loaded-channel collapse to at
  most one, and 30 seconds of continuous confirmation. A measured pump-safe
  piezo baseline is preferred. If pumps prevented that baseline, the path may
  use the configured piezo enter threshold instead, but only after current
  piezo evidence is pump-free, below its exit threshold, and below the
  autocorrelation exit threshold.
- The short-cycle path opens only on a robust capSense load impulse rising from
  a clear or weak prior sample. The epoch must subsequently observe the
  adaptive load state, then show a strong unload impulse, score collapse to at
  most 40% of that visit's peak, at most one loaded channel, and fresh
  pump-free quiet piezo evidence. It confirms for ten seconds and expires after
  five minutes if no exit is certified. A qualified capSense collapse is
  remembered while the detector waits for quiet piezo evidence, but the epoch
  is discarded without issuing a certificate if the native adaptive detector
  clears first. Once pump-free quiet piezo starts confirmation, continuing
  collapsed capSense evidence owns the ten-second dwell; uncorroborated piezo
  movement alone does not restart it.

Near the piezo noise floor, autocorrelation alone is not allowed to veto an
exit or revoke a certificate. A short-cycle certificate remains clear through
sub-threshold residual mattress load and is revoked by a robust capSense
return, a new load impulse, or a non-noise piezo entry. The sustained
certificate retains its stricter rebound maintenance. Source gaps, stale
evidence, and process restart remain fail-closed. Pump-active evidence cannot
create a certificate, but a later pump cycle does not erase an already
certified exit while continuous capSense evidence still supports clear.

The v2 thresholds were replayed over 69,156 retained side-samples spanning all
available capSense history. The only certificates were the labeled September
21 morning exit and the two operator-labeled staggered short visits. The
short-cycle visits certified ten seconds after their observed unload
transitions, while three pump-ambiguous historical collapses remained
uncertified and later followed the native adaptive clear.

The piezo processor records its guarded pump mode on every presence decision,
including while the existing detector remains in its present hysteresis state,
so the fused decision cannot interpret an active-pump exit window as pump-safe.

Fused comparison topics mirror the primary layout under a `fused` suffix:

- `state/occupancy/<side>/fused` — plain, non-retained `ON` / `OFF`
  heartbeat (`<side>_occupancy_fused` binary sensor, `expire_after: 3`);
- `availability/occupancy/<side>/fused` — retained per-side
  `online` / `offline`;
- `state/occupancy/<side>/fused/decision` — retained, low-churn
  classification, reason, provenance, certificate basis, baseline source, and
  short-cycle progress or blocked-gate diagnostics
  (`<side>_occupancy_fused_decision`, diagnostic, disabled and hidden by
  default).

Temporary fused-shadow discovery and retained diagnostic topics from the
original fused rollout remain tombstoned on every connect.

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

## Evidence-of-life primary occupancy

`eol-occupancy-v4` (`modules/common/eol_occupancy.py`) drives the primary Home
Assistant occupancy entities. Its question is whether a living body is on the
side, not whether something loads the surface relative to a baseline.

- capSense is the side-local body signal: an abrupt load step plus
  breathing-scale micro-motion (median absolute one-second change of the
  center channel).
- Piezo 1–10 Hz energy separates people (roughly 60k–1M) from objects and an
  empty bed (roughly 1–2k) and supplies side-dominant movement bursts. A still
  sleeper couples almost equally into both piezo channels, so piezo is never
  used to localize a quiet person.
- Entry: a load step with an own-side burst is `provisional`, then `occupied`
  once sustained load plus life evidence holds for 15 seconds after the first
  20 (about 35 seconds after entry). Otherwise it is revoked after 150 seconds
  (objects, edge sits, a partner reaching across). A sustained loaded side
  with micro-motion also enters after three minutes.
- Exit: an unload step back near the empty reference with own vitals collapsed
  to the partner-coupling level and a quiet capSense window clears both the
  fast and confirmed signals together, typically 7–60 seconds after the
  person leaves. Slow paths clear an unloaded quiet side after three minutes,
  or a still-loaded side after ten minutes without vitals anywhere in the bed.
- The empty reference adapts only while the side is verified empty; it
  qualifies transitions but never holds a side occupied.

`modules/eol-occupancy` follows the raw capSense and piezo streams (NATS on
current firmware, `*.RAW` files otherwise), upserts one `eol_occupancy_state`
row per side on every state change and at least every five seconds, and
checkpoints the detector to `eol-occupancy-checkpoint.json` so restarts keep
the empty reference and state. The drizzle migration owns the table; the
module never creates it, because `sp-update` starts modules before the app
migrates. Timestamps are the module's receipt time, forced strictly
increasing; a backward wall-clock step of more than a minute rebases the
rolling windows while keeping each side's state and reference.

MQTT publishes the permanent algorithm-neutral primary topics:

- `state/occupancy/<side>` — plain, non-retained `ON` / `OFF` heartbeat of the
  confirmed state (a provisional entry stays `OFF`);
- `availability/occupancy/<side>` — retained per-side `online` / `offline`;
- `state/occupancy/<side>/decision` — retained, low-churn decision: the
  `classification` (`empty`, `provisional`, `occupied`, or why the primary is
  unavailable), fast and confirmed flags, last event, state age, and the
  evidence diagnostics at the last change.

The primary side is unavailable when its row is missing, older than 30
seconds, unreadable, or degraded. Degraded means recent piezo energy is
missing on either side: capSense-only exits replayed at 88.6% on the night
core and can clear a very still sleeper, so absence-triggered automations must
not see a degraded `OFF`. The decision sensor uses Pod availability only, so
it stays visible with the reason (`degraded`, `stale`, `no_data`,
`source_error`) while the primary is unavailable.

Home Assistant discovery updates the existing primary binary sensors in place,
preserving their unique IDs and entity IDs (`expire_after: 3`, one-second
heartbeat). HomeKit, API/web, and auto-off continue to use the adaptive shared
runtime.

Validation (2026-09-13 → 09-28 raw archive, labels from operator statements
and independent Home Assistant evidence only): confirmed occupancy scored
99.74% on occupied time and 100% on empty time with no false clears during
sleep, against 100% / 36.9% for fused-v2. Over the final 24 hours it was never
occupied while the bed was verifiably empty (both piezo channels below 20k),
while fused-v2 held each side occupied for about seven such hours. The
streaming port agrees with the offline reference on 99.96–99.97% of seconds,
and replaying raw recorder CBOR on the Pod reproduced the reference events
while using under 1% of one core.

Replay archived study chunks with
`python -m common.eol_replay --raw-dir DIR --from ISO --to ISO --out FILE`
from `modules/` (requires `cbor2`).
