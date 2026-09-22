import { describe, expect, it } from 'vitest'
import {
  FusedOccupancySide,
  type AdaptiveOccupancySample,
  type FusedOccupancyDecision,
  type PiezoOccupancySample,
} from '../fusedOccupancy'
import replayFixtureData from './fixtures/fusedOccupancyReplay.json'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const BASE = Date.UTC(2026, 8, 21, 14, 26, 0)

type ReplaySide = 'left' | 'right'
type AdaptiveReplayRow = [
  timestampSeconds: number,
  loadPresent: boolean,
  score: number,
  loadedChannels: number,
  loadVelocityScore: number,
  unloadVelocityScore: number,
  entryVelocitySupported: boolean,
]
type PiezoReplayRow = [
  timestampSeconds: number,
  present: boolean,
  energy: number,
  autocorrelationQuality: number,
  decisionReason: string,
  pumpMode: 'asymmetric' | 'symmetric' | null,
]

interface ReplayScenario {
  id: string
  side: ReplaySide
  expectation: {
    certificateMode: 'entry_transition' | 'sustained_baseline' | null
    clearByMs?: number
    maintainClearThroughMs?: number
    mustRemainOccupiedThroughMs?: number
    occupiedFromMs?: number
    piezoBaselineSource?:
      'configured_threshold' | 'entry_window' | 'observed'
    mustNotCertify?: boolean
  }
  adaptive: AdaptiveReplayRow[]
  piezo: PiezoReplayRow[]
}

interface ReplayFixture {
  fixed: {
    adaptiveAlgorithmVersion: string
    piezoEnterThreshold: number
    piezoExitThreshold: number
  }
  scenarios: ReplayScenario[]
}

function replaySide(value: string): ReplaySide {
  if (value === 'left' || value === 'right') return value
  throw new Error(`invalid replay side: ${value}`)
}

function certificateMode(
  value: string | null,
): ReplayScenario['expectation']['certificateMode'] {
  if (
    value === null
    || value === 'entry_transition'
    || value === 'sustained_baseline'
  ) {
    return value
  }
  throw new Error(`invalid certificate mode: ${value}`)
}

function piezoBaselineSource(
  value: string | undefined,
): ReplayScenario['expectation']['piezoBaselineSource'] {
  if (
    value === undefined
    || value === 'configured_threshold'
    || value === 'entry_window'
    || value === 'observed'
  ) {
    return value
  }
  throw new Error(`invalid piezo baseline source: ${value}`)
}

const replayFixture: ReplayFixture = {
  fixed: replayFixtureData.fixed,
  scenarios: replayFixtureData.scenarios.map(scenario => ({
    id: scenario.id,
    side: replaySide(scenario.side),
    expectation: {
      ...scenario.expectation,
      certificateMode: certificateMode(
        scenario.expectation.certificateMode,
      ),
      piezoBaselineSource: piezoBaselineSource(
        scenario.expectation.piezoBaselineSource,
      ),
    },
    adaptive: scenario.adaptive.map((row): AdaptiveReplayRow => {
      if (row.length !== 7) {
        throw new Error(`invalid adaptive replay row in ${scenario.id}`)
      }
      return [
        Number(row[0]),
        Boolean(row[1]),
        Number(row[2]),
        Number(row[3]),
        Number(row[4]),
        Number(row[5]),
        Boolean(row[6]),
      ]
    }),
    piezo: scenario.piezo.map((row): PiezoReplayRow => {
      if (row.length !== 6) {
        throw new Error(`invalid piezo replay row in ${scenario.id}`)
      }
      const pumpMode = row[5]
      if (
        pumpMode !== null
        && pumpMode !== 'asymmetric'
        && pumpMode !== 'symmetric'
      ) {
        throw new Error(`invalid pump mode in ${scenario.id}`)
      }
      return [
        Number(row[0]),
        Boolean(row[1]),
        Number(row[2]),
        Number(row[3]),
        String(row[4]),
        pumpMode,
      ]
    }),
  })),
}

function adaptive(
  timestampMs: number,
  overrides: Partial<AdaptiveOccupancySample> = {},
): AdaptiveOccupancySample {
  return {
    side: 'right',
    sampleTimestampMs: timestampMs,
    loadPresent: true,
    classification: 'loaded_unconfirmed',
    score: 24,
    loadedChannels: 3,
    loadVelocityScore: 0,
    unloadVelocityScore: 0,
    entryVelocitySupported: false,
    algorithmVersion: 'adaptive-cap-v3',
    ...overrides,
  }
}

function piezo(
  timestampMs: number,
  overrides: Partial<PiezoOccupancySample> = {},
): PiezoOccupancySample {
  return {
    side: 'right',
    sampleTimestampMs: timestampMs,
    present: true,
    energy: 1_000_000,
    autocorrelationQuality: 0.6,
    enterThreshold: 400_000,
    exitThreshold: 150_000,
    decisionReason: 'present_hold',
    pumpMode: null,
    ...overrides,
  }
}

function feedLoadedBaseline(
  detector: FusedOccupancySide,
  startMs = BASE,
): number {
  for (let offset = 0; offset <= 3 * MINUTE; offset += 10 * SECOND) {
    const timestampMs = startMs + offset
    detector.update({
      nowMs: timestampMs,
      adaptive: adaptive(timestampMs),
      piezo: piezo(timestampMs),
    })
  }
  return startMs + 3 * MINUTE
}

function certifySeptember21Exit(
  detector: FusedOccupancySide,
): ReturnType<FusedOccupancySide['update']> {
  const loadedThrough = feedLoadedBaseline(detector)
  detector.update({
    nowMs: loadedThrough + 10 * SECOND,
    adaptive: adaptive(loadedThrough + 10 * SECOND),
    piezo: piezo(loadedThrough + 10 * SECOND),
  })
  const collapseAt = loadedThrough + 32 * SECOND
  const collapsedAdaptive = adaptive(collapseAt, {
    score: 3.1,
    loadedChannels: 1,
    unloadVelocityScore: 8,
  })
  const collapsedPiezo = piezo(collapseAt, {
    present: true,
    energy: 100_000,
    autocorrelationQuality: 0.1,
    decisionReason: 'exit',
  })

  detector.update({
    nowMs: collapseAt,
    adaptive: collapsedAdaptive,
    piezo: collapsedPiezo,
  })
  return detector.update({
    nowMs: collapseAt + 30 * SECOND,
    adaptive: adaptive(collapseAt + 30 * SECOND, {
      score: 3.2,
      loadedChannels: 1,
      unloadVelocityScore: 0,
    }),
    piezo: piezo(collapseAt + 30 * SECOND, {
      present: false,
      energy: 90_000,
      autocorrelationQuality: 0.1,
      decisionReason: 'absent_hold',
    }),
  })
}

function maintainCertifiedResidual(
  detector: FusedOccupancySide,
  fromMs: number,
  throughMs: number,
): ReturnType<FusedOccupancySide['update']> {
  const updateAt = (timestampMs: number) => detector.update({
    nowMs: timestampMs,
    adaptive: adaptive(timestampMs, {
      score: 4.8,
      loadedChannels: 2,
    }),
    piezo: piezo(timestampMs, {
      present: true,
      energy: 500_000,
      decisionReason: 'cross_side_movement',
    }),
  })
  let result = updateAt(fromMs)
  let lastTimestampMs = fromMs
  for (let timestampMs = fromMs + 10 * SECOND; timestampMs <= throughMs; timestampMs += 10 * SECOND) {
    result = updateAt(timestampMs)
    lastTimestampMs = timestampMs
  }
  if (lastTimestampMs !== throughMs) {
    result = updateAt(throughMs)
  }
  return result
}

function certifyShortCycle(
  detector: FusedOccupancySide,
): ReturnType<FusedOccupancySide['update']> {
  detector.update({
    nowMs: BASE,
    adaptive: adaptive(BASE, {
      loadPresent: false,
      classification: 'empty',
      score: 2,
      loadedChannels: 0,
    }),
    piezo: piezo(BASE, {
      present: false,
      energy: 100_000,
      autocorrelationQuality: 0.1,
    }),
  })
  detector.update({
    nowMs: BASE + 5 * SECOND,
    adaptive: adaptive(BASE + 5 * SECOND, {
      loadPresent: false,
      score: 12,
      loadedChannels: 2,
      loadVelocityScore: 10,
      entryVelocitySupported: true,
    }),
    piezo: piezo(BASE, {
      present: false,
      energy: 100_000,
      autocorrelationQuality: 0.1,
    }),
  })
  detector.update({
    nowMs: BASE + 15 * SECOND,
    adaptive: adaptive(BASE + 15 * SECOND, {
      score: 20,
      loadedChannels: 3,
    }),
    piezo: piezo(BASE, {
      present: false,
      energy: 100_000,
      autocorrelationQuality: 0.1,
    }),
  })
  detector.update({
    nowMs: BASE + 30 * SECOND,
    adaptive: adaptive(BASE + 30 * SECOND, {
      score: 3,
      loadedChannels: 1,
      unloadVelocityScore: 17,
    }),
    piezo: piezo(BASE, {
      present: false,
      energy: 100_000,
      autocorrelationQuality: 0.1,
    }),
  })
  return detector.update({
    nowMs: BASE + 40 * SECOND,
    adaptive: adaptive(BASE + 40 * SECOND, {
      score: 3,
      loadedChannels: 1,
    }),
    piezo: piezo(BASE, {
      present: false,
      energy: 100_000,
      autocorrelationQuality: 0.1,
    }),
  })
}

function replayScenario(
  scenario: ReplayScenario,
): Array<{ nowMs: number, decision: FusedOccupancyDecision }> {
  const detector = new FusedOccupancySide(scenario.side, {
    provenanceEpoch: scenario.id,
  })
  let piezoIndex = -1
  return scenario.adaptive.map(([
    timestampSeconds,
    loadPresent,
    score,
    loadedChannels,
    loadVelocityScore,
    unloadVelocityScore,
    entryVelocitySupported,
  ]) => {
    while (
      piezoIndex + 1 < scenario.piezo.length
      && scenario.piezo[piezoIndex + 1][0] <= timestampSeconds
    ) {
      piezoIndex += 1
    }
    const piezoRow = scenario.piezo[piezoIndex]
    const nowMs = timestampSeconds * SECOND
    const decision = detector.update({
      nowMs,
      adaptive: {
        side: scenario.side,
        sampleTimestampMs: nowMs,
        loadPresent,
        classification: loadPresent ? 'loaded_unconfirmed' : 'empty',
        score,
        loadedChannels,
        loadVelocityScore,
        unloadVelocityScore,
        entryVelocitySupported,
        algorithmVersion: replayFixture.fixed.adaptiveAlgorithmVersion,
      },
      piezo: piezoRow
        ? {
            side: scenario.side,
            sampleTimestampMs: piezoRow[0] * SECOND,
            present: piezoRow[1],
            energy: piezoRow[2],
            autocorrelationQuality: piezoRow[3],
            enterThreshold: replayFixture.fixed.piezoEnterThreshold,
            exitThreshold: replayFixture.fixed.piezoExitThreshold,
            decisionReason: piezoRow[4],
            pumpMode: piezoRow[5],
          }
        : null,
    })
    return { nowMs, decision }
  })
}

describe('FusedOccupancySide', () => {
  it('projects fresh adaptive load, adaptive clear, and stale input conservatively', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'test',
    })

    expect(detector.update({
      nowMs: BASE,
      adaptive: adaptive(BASE),
      piezo: null,
    })).toMatchObject({
      state: 'occupied',
      occupied: true,
      available: true,
      classification: 'occupied_adaptive',
      reason: 'adaptive_load',
    })

    expect(detector.update({
      nowMs: BASE + SECOND,
      adaptive: adaptive(BASE + SECOND, {
        loadPresent: false,
        classification: 'empty',
        score: 1,
        loadedChannels: 0,
      }),
      piezo: null,
    })).toMatchObject({
      state: 'clear',
      occupied: false,
      available: true,
      classification: 'clear_adaptive',
      reason: 'adaptive_clear',
    })

    expect(detector.update({
      nowMs: BASE + 62 * SECOND,
      adaptive: adaptive(BASE + SECOND, {
        loadPresent: false,
        classification: 'empty',
        score: 1,
        loadedChannels: 0,
      }),
      piezo: null,
    })).toMatchObject({
      state: 'unavailable',
      occupied: null,
      available: false,
      classification: 'unavailable',
      reason: 'adaptive_source_stale',
    })
  })

  it('certifies the September 21 collapse after thirty seconds', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'september-21',
    })

    const result = certifySeptember21Exit(detector)

    expect(result).toMatchObject({
      state: 'clear',
      classification: 'clear_exit_certified',
      reason: 'exit_certified',
      certificatePhase: 'certified',
      certificate: {
        transitionAtMs: BASE + 3 * MINUTE + 32 * SECOND,
        confirmedAtMs: BASE + 4 * MINUTE + 2 * SECOND,
        adaptiveBaselineScore: 24,
        piezoBaselineEnergy: 1_000_000,
      },
    })
  })

  it('requires adaptive evidence to advance during confirmation', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'stalled-confirmation',
    })
    const loadedThrough = feedLoadedBaseline(detector)
    const collapseAt = loadedThrough + 10 * SECOND
    const collapsedAdaptive = adaptive(collapseAt, {
      score: 3,
      loadedChannels: 1,
    })
    const collapsedPiezo = piezo(collapseAt, {
      present: true,
      energy: 100_000,
      autocorrelationQuality: 0.1,
    })

    detector.update({
      nowMs: collapseAt,
      adaptive: collapsedAdaptive,
      piezo: collapsedPiezo,
    })
    const stalled = detector.update({
      nowMs: collapseAt + 30 * SECOND,
      adaptive: collapsedAdaptive,
      piezo: collapsedPiezo,
    })
    expect(stalled.classification).toBe('occupied_adaptive')

    const advanced = detector.update({
      nowMs: collapseAt + 30 * SECOND,
      adaptive: adaptive(collapseAt + 30 * SECOND, {
        score: 3,
        loadedChannels: 1,
      }),
      piezo: collapsedPiezo,
    })
    expect(advanced.classification).toBe('clear_exit_certified')
  })

  it('maintains the September 21 certificate through weak two-channel residual load and piezo movement', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'september-21',
    })
    const certified = certifySeptember21Exit(detector)
    const later = BASE + 19 * MINUTE + 20 * SECOND

    const result = maintainCertifiedResidual(
      detector,
      (certified.certificate?.confirmedAtMs ?? BASE) + 10 * SECOND,
      later,
    )

    expect(result).toMatchObject({
      state: 'clear',
      classification: 'clear_exit_certified',
      certificatePhase: 'certified',
    })
    expect(result.certificate?.id).toBe(certified.certificate?.id)
  })

  it('suspends certified clear immediately on a credible quiet return', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'return',
    })
    certifySeptember21Exit(detector)
    const returnAt = BASE + 5 * MINUTE
    maintainCertifiedResidual(
      detector,
      BASE + 4 * MINUTE + 12 * SECOND,
      returnAt - 8 * SECOND,
    )

    const result = detector.update({
      nowMs: returnAt,
      adaptive: adaptive(returnAt, {
        loadPresent: false,
        classification: 'empty',
        score: 5,
        loadedChannels: 2,
        loadVelocityScore: 3.5,
        entryVelocitySupported: true,
      }),
      piezo: piezo(returnAt, {
        present: false,
        energy: 180_000,
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      classification: 'occupied_adaptive',
      reason: 'credible_entry',
      certificatePhase: 'observing',
      certificate: null,
      lastCertificateInvalidationReason: 'credible_entry',
    })
  })

  it('does not certify generic piezo absence without a robust loaded baseline and cap collapse', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'generic-absence',
    })

    for (let offset = 0; offset <= 4 * MINUTE; offset += 30 * SECOND) {
      detector.update({
        nowMs: BASE + offset,
        adaptive: adaptive(BASE + offset, {
          score: 5,
          loadedChannels: 2,
        }),
        piezo: piezo(BASE + offset, {
          present: false,
          energy: 100_000,
          autocorrelationQuality: 0.1,
        }),
      })
    }

    const result = detector.update({
      nowMs: BASE + 4 * MINUTE,
      adaptive: adaptive(BASE + 4 * MINUTE, {
        score: 5,
        loadedChannels: 2,
      }),
      piezo: piezo(BASE + 4 * MINUTE, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      classification: 'occupied_adaptive',
      certificatePhase: 'observing',
      certificate: null,
    })
  })

  it('does not issue while pump state is unsupported', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'pump',
    })
    const loadedThrough = feedLoadedBaseline(detector)
    const collapseAt = loadedThrough + 10 * SECOND

    detector.update({
      nowMs: collapseAt,
      adaptive: adaptive(collapseAt, {
        score: 3,
        loadedChannels: 1,
      }),
      piezo: piezo(collapseAt, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
        pumpMode: 'symmetric',
      }),
    })
    const result = detector.update({
      nowMs: collapseAt + 30 * SECOND,
      adaptive: adaptive(collapseAt + 30 * SECOND, {
        score: 3,
        loadedChannels: 1,
      }),
      piezo: piezo(collapseAt + 30 * SECOND, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
        pumpMode: 'symmetric',
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      certificatePhase: 'armed',
      certificate: null,
    })
  })

  it('preserves an established certificate through later pump activity', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'post-certificate-pump',
    })
    const certified = certifySeptember21Exit(detector)
    const confirmedAt = certified.certificate?.confirmedAtMs ?? BASE

    const result = detector.update({
      nowMs: confirmedAt + 10 * SECOND,
      adaptive: adaptive(confirmedAt + 10 * SECOND, {
        score: 4.8,
        loadedChannels: 2,
      }),
      piezo: piezo(confirmedAt + 10 * SECOND, {
        present: false,
        energy: 2_000,
        autocorrelationQuality: 0.8,
        decisionReason: 'pump_suppressed',
        pumpMode: 'symmetric',
      }),
    })

    expect(result).toMatchObject({
      state: 'clear',
      classification: 'clear_exit_certified',
      certificatePhase: 'certified',
      certificate: {
        id: certified.certificate?.id,
      },
    })
  })

  it('invalidates a certificate when its required piezo evidence becomes stale', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'stale-piezo',
    })
    const certified = certifySeptember21Exit(detector)
    const confirmedAt = certified.certificate?.confirmedAtMs ?? BASE
    const lastPiezo = piezo(confirmedAt, {
      present: false,
      energy: 180_000,
      autocorrelationQuality: 0.1,
    })
    let result = certified
    for (let offset = 10 * SECOND; offset <= 91 * SECOND; offset += 10 * SECOND) {
      const nowMs = confirmedAt + Math.min(offset, 91 * SECOND)
      result = detector.update({
        nowMs,
        adaptive: adaptive(nowMs, {
          score: 4,
          loadedChannels: 2,
        }),
        piezo: lastPiezo,
      })
    }
    result = detector.update({
      nowMs: confirmedAt + 91 * SECOND,
      adaptive: adaptive(confirmedAt + 91 * SECOND, {
        score: 4,
        loadedChannels: 2,
      }),
      piezo: lastPiezo,
    })

    expect(result).toMatchObject({
      state: 'occupied',
      classification: 'occupied_adaptive',
      certificatePhase: 'observing',
      certificate: null,
      lastCertificateInvalidationReason: 'piezo_source_stale',
    })
  })

  it('invalidates certified clear when adaptive evidence exceeds the source-gap budget', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'stale-adaptive',
    })
    const certified = certifySeptember21Exit(detector)
    const confirmedAt = certified.certificate?.confirmedAtMs ?? BASE
    const lastAdaptive = adaptive(confirmedAt, {
      score: 4,
      loadedChannels: 2,
    })

    const result = detector.update({
      nowMs: confirmedAt + 31 * SECOND,
      adaptive: lastAdaptive,
      piezo: piezo(confirmedAt + 31 * SECOND, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      classification: 'occupied_adaptive',
      certificatePhase: 'observing',
      certificate: null,
      lastCertificateInvalidationReason: 'adaptive_source_gap',
    })
  })

  it('rejects future and regressed adaptive timestamps', () => {
    const futureDetector = new FusedOccupancySide('right', {
      provenanceEpoch: 'future',
    })
    expect(futureDetector.update({
      nowMs: BASE,
      adaptive: adaptive(BASE + 6 * SECOND),
      piezo: null,
    })).toMatchObject({
      classification: 'unavailable',
      reason: 'adaptive_source_future',
    })

    const regressedDetector = new FusedOccupancySide('right', {
      provenanceEpoch: 'regressed',
    })
    regressedDetector.update({
      nowMs: BASE + SECOND,
      adaptive: adaptive(BASE + SECOND),
      piezo: null,
    })
    expect(regressedDetector.update({
      nowMs: BASE + 2 * SECOND,
      adaptive: adaptive(BASE),
      piezo: null,
    })).toMatchObject({
      classification: 'unavailable',
      reason: 'adaptive_timestamp_regressed',
    })
  })

  it('does not resurrect a certificate after a provider restart', () => {
    const original = new FusedOccupancySide('right', {
      provenanceEpoch: 'before-restart',
    })
    const certified = certifySeptember21Exit(original)
    const nowMs = certified.certificate?.confirmedAtMs ?? BASE
    const restarted = new FusedOccupancySide('right', {
      provenanceEpoch: 'after-restart',
    })

    const result = restarted.update({
      nowMs,
      adaptive: adaptive(nowMs, {
        score: 4,
        loadedChannels: 2,
      }),
      piezo: piezo(nowMs, {
        present: false,
        energy: 180_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      classification: 'occupied_adaptive',
      certificatePhase: 'observing',
      certificate: null,
      provenanceEpoch: 'after-restart',
    })
  })

  it('does not open a short cycle from movement on an already robustly loaded side', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'robust-movement',
    })
    detector.update({
      nowMs: BASE,
      adaptive: adaptive(BASE),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    detector.update({
      nowMs: BASE + 5 * SECOND,
      adaptive: adaptive(BASE + 5 * SECOND, {
        score: 30,
        loadVelocityScore: 6,
        entryVelocitySupported: true,
      }),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    detector.update({
      nowMs: BASE + 10 * SECOND,
      adaptive: adaptive(BASE + 10 * SECOND, {
        score: 3,
        loadedChannels: 1,
        unloadVelocityScore: 20,
      }),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    const result = detector.update({
      nowMs: BASE + 30 * SECOND,
      adaptive: adaptive(BASE + 30 * SECOND, {
        score: 3,
        loadedChannels: 1,
      }),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      certificatePhase: 'observing',
      certificate: null,
      shortCycle: null,
    })
  })

  it('requires the entry epoch to observe adaptive load before certifying', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'transient-entry',
    })
    detector.update({
      nowMs: BASE,
      adaptive: adaptive(BASE, {
        loadPresent: false,
        classification: 'empty',
        score: 2,
        loadedChannels: 0,
      }),
      piezo: piezo(BASE, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    detector.update({
      nowMs: BASE + 5 * SECOND,
      adaptive: adaptive(BASE + 5 * SECOND, {
        loadPresent: false,
        classification: 'empty',
        score: 12,
        loadedChannels: 2,
        loadVelocityScore: 10,
        entryVelocitySupported: true,
      }),
      piezo: piezo(BASE, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    detector.update({
      nowMs: BASE + 30 * SECOND,
      adaptive: adaptive(BASE + 30 * SECOND, {
        loadPresent: false,
        classification: 'empty',
        score: 2,
        loadedChannels: 0,
        unloadVelocityScore: 10,
      }),
      piezo: piezo(BASE, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    const result = detector.update({
      nowMs: BASE + 40 * SECOND,
      adaptive: adaptive(BASE + 40 * SECOND, {
        loadPresent: false,
        classification: 'empty',
        score: 2,
        loadedChannels: 0,
      }),
      piezo: piezo(BASE, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'clear',
      classification: 'clear_adaptive',
      certificate: null,
      shortCycle: {
        loadPresentObserved: false,
        blockedReason: 'adaptive_load_not_confirmed',
      },
    })
  })

  it('requires a strong adaptive unload impulse to start short-cycle confirmation', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'weak-unload',
    })
    detector.update({
      nowMs: BASE,
      adaptive: adaptive(BASE, {
        loadPresent: false,
        classification: 'empty',
        score: 2,
        loadedChannels: 0,
      }),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    detector.update({
      nowMs: BASE + 5 * SECOND,
      adaptive: adaptive(BASE + 5 * SECOND, {
        loadPresent: false,
        score: 12,
        loadedChannels: 2,
        loadVelocityScore: 10,
        entryVelocitySupported: true,
      }),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    detector.update({
      nowMs: BASE + 15 * SECOND,
      adaptive: adaptive(BASE + 15 * SECOND, {
        score: 12,
        loadedChannels: 2,
      }),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    const result = detector.update({
      nowMs: BASE + 30 * SECOND,
      adaptive: adaptive(BASE + 30 * SECOND, {
        score: 3,
        loadedChannels: 1,
        unloadVelocityScore: 1,
      }),
      piezo: piezo(BASE, {
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      certificate: null,
      shortCycle: {
        blockedReason: 'adaptive_unload_too_weak',
      },
    })
  })

  it('remembers a strong unload while waiting for piezo to become quiet', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'delayed-piezo-quiet',
    })
    detector.update({
      nowMs: BASE,
      adaptive: adaptive(BASE, {
        loadPresent: false,
        classification: 'empty',
        score: 2,
        loadedChannels: 0,
      }),
      piezo: piezo(BASE, {
        energy: 300_000,
        autocorrelationQuality: 0.4,
      }),
    })
    detector.update({
      nowMs: BASE + 5 * SECOND,
      adaptive: adaptive(BASE + 5 * SECOND, {
        loadPresent: false,
        score: 12,
        loadedChannels: 2,
        loadVelocityScore: 10,
        entryVelocitySupported: true,
      }),
      piezo: piezo(BASE, {
        energy: 300_000,
        autocorrelationQuality: 0.4,
      }),
    })
    detector.update({
      nowMs: BASE + 15 * SECOND,
      adaptive: adaptive(BASE + 15 * SECOND, {
        score: 20,
        loadedChannels: 3,
      }),
      piezo: piezo(BASE, {
        energy: 300_000,
        autocorrelationQuality: 0.4,
      }),
    })
    const waiting = detector.update({
      nowMs: BASE + 30 * SECOND,
      adaptive: adaptive(BASE + 30 * SECOND, {
        score: 3,
        loadedChannels: 1,
        unloadVelocityScore: 17,
      }),
      piezo: piezo(BASE, {
        energy: 300_000,
        autocorrelationQuality: 0.4,
      }),
    })
    expect(waiting).toMatchObject({
      state: 'occupied',
      certificate: null,
      shortCycle: {
        adaptiveCollapseAtMs: BASE + 30 * SECOND,
        blockedReason: 'piezo_not_quiet',
      },
    })

    detector.update({
      nowMs: BASE + 60 * SECOND,
      adaptive: adaptive(BASE + 60 * SECOND, {
        score: 3,
        loadedChannels: 1,
      }),
      piezo: piezo(BASE + 60 * SECOND, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })
    const result = detector.update({
      nowMs: BASE + 70 * SECOND,
      adaptive: adaptive(BASE + 70 * SECOND, {
        score: 3,
        loadedChannels: 1,
      }),
      piezo: piezo(BASE + 70 * SECOND, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'clear',
      certificate: {
        basis: 'entry_transition',
        transitionAtMs: BASE + 60 * SECOND,
      },
    })
  })

  it('revokes short-cycle clear on a new adaptive entry', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'short-adaptive-return',
    })
    expect(certifyShortCycle(detector)).toMatchObject({
      state: 'clear',
      certificate: {
        basis: 'entry_transition',
      },
    })

    const result = detector.update({
      nowMs: BASE + 50 * SECOND,
      adaptive: adaptive(BASE + 50 * SECOND, {
        score: 12,
        loadedChannels: 2,
        loadVelocityScore: 4,
        entryVelocitySupported: true,
      }),
      piezo: piezo(BASE, {
        present: false,
        energy: 100_000,
        autocorrelationQuality: 0.1,
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      reason: 'credible_entry',
      certificate: null,
      lastCertificateInvalidationReason: 'credible_entry',
    })
  })

  it('revokes short-cycle clear on a new piezo entry', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'short-piezo-return',
    })
    expect(certifyShortCycle(detector)).toMatchObject({
      state: 'clear',
      certificate: {
        basis: 'entry_transition',
      },
    })

    const result = detector.update({
      nowMs: BASE + 50 * SECOND,
      adaptive: adaptive(BASE + 50 * SECOND, {
        score: 3,
        loadedChannels: 1,
        entryVelocitySupported: true,
      }),
      piezo: piezo(BASE + 50 * SECOND, {
        present: true,
        energy: 500_000,
        autocorrelationQuality: 0.5,
        decisionReason: 'std_enter',
      }),
    })

    expect(result).toMatchObject({
      state: 'occupied',
      reason: 'credible_entry',
      certificate: null,
      lastCertificateInvalidationReason: 'credible_entry',
    })
  })

  it('ignores an uncorroborated cross-side piezo entry after clear', () => {
    const detector = new FusedOccupancySide('right', {
      provenanceEpoch: 'cross-side-piezo',
    })
    const certified = certifyShortCycle(detector)

    const result = detector.update({
      nowMs: BASE + 50 * SECOND,
      adaptive: adaptive(BASE + 50 * SECOND, {
        score: 5.5,
        loadedChannels: 3,
        entryVelocitySupported: false,
      }),
      piezo: piezo(BASE + 50 * SECOND, {
        present: true,
        energy: 565_000,
        autocorrelationQuality: 0.265,
        decisionReason: 'std_enter',
      }),
    })

    expect(result).toMatchObject({
      state: 'clear',
      certificate: {
        id: certified.certificate?.id,
      },
    })
  })

  it.each(
    replayFixture.scenarios.filter(
      scenario => scenario.expectation.certificateMode === 'entry_transition',
    ),
  )('certifies captured short visit $id', (scenario) => {
    const decisions = replayScenario(scenario)
    const occupiedFromMs = scenario.expectation.occupiedFromMs
    const occupiedThroughMs = scenario.expectation.mustRemainOccupiedThroughMs
    const prematureClear = decisions.find(({ nowMs, decision }) =>
      occupiedFromMs !== undefined
      && occupiedThroughMs !== undefined
      && nowMs >= occupiedFromMs
      && nowMs <= occupiedThroughMs
      && decision.state === 'clear')
    const certified = decisions.find(
      ({ decision }) => decision.classification === 'clear_exit_certified',
    )

    expect(prematureClear).toBeUndefined()
    expect(certified).toBeDefined()
    expect(certified?.nowMs).toBeLessThanOrEqual(
      scenario.expectation.clearByMs ?? Number.POSITIVE_INFINITY,
    )
    expect(certified?.decision).toMatchObject({
      certificate: {
        basis: 'entry_transition',
        piezoBaselineSource:
          scenario.expectation.piezoBaselineSource,
      },
    })
    const final = decisions.at(-1)
    expect(final?.nowMs).toBeGreaterThanOrEqual(
      scenario.expectation.maintainClearThroughMs ?? 0,
    )
    expect(final?.decision).toMatchObject({
      state: 'clear',
      certificate: {
        id: certified?.decision.certificate?.id,
        basis: 'entry_transition',
        piezoBaselineSource:
          scenario.expectation.piezoBaselineSource,
      },
    })
  })

  it.each(
    replayFixture.scenarios.filter(
      scenario => scenario.expectation.certificateMode === 'sustained_baseline',
    ),
  )('preserves sustained certification for $id', (scenario) => {
    const decisions = replayScenario(scenario)
    const occupiedFromMs = scenario.expectation.occupiedFromMs
    const occupiedThroughMs = scenario.expectation.mustRemainOccupiedThroughMs
    const prematureClear = decisions.find(({ nowMs, decision }) =>
      occupiedFromMs !== undefined
      && occupiedThroughMs !== undefined
      && nowMs >= occupiedFromMs
      && nowMs <= occupiedThroughMs
      && decision.state === 'clear')
    const certified = decisions.find(
      ({ decision }) => decision.classification === 'clear_exit_certified',
    )

    expect(prematureClear).toBeUndefined()
    expect(certified).toBeDefined()
    expect(certified?.nowMs).toBeLessThanOrEqual(
      scenario.expectation.clearByMs ?? Number.POSITIVE_INFINITY,
    )
    expect(certified?.decision).toMatchObject({
      certificate: {
        basis: 'sustained_baseline',
        piezoBaselineSource:
          scenario.expectation.piezoBaselineSource,
      },
    })
    const final = decisions.at(-1)
    expect(final?.nowMs).toBeGreaterThanOrEqual(
      scenario.expectation.maintainClearThroughMs ?? 0,
    )
    expect(final?.decision).toMatchObject({
      state: 'clear',
      certificate: {
        id: certified?.decision.certificate?.id,
        basis: 'sustained_baseline',
      },
    })
  })

  it.each(
    replayFixture.scenarios.filter(
      scenario => scenario.expectation.mustNotCertify,
    ),
  )('does not certify pump-ambiguous replay $id', (scenario) => {
    const decisions = replayScenario(scenario)

    expect(decisions.every(({ decision }) => decision.certificate === null))
      .toBe(true)
  })
})
