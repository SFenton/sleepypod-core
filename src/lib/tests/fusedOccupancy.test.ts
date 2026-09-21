import { describe, expect, it } from 'vitest'
import {
  FusedOccupancySide,
  type AdaptiveOccupancySample,
  type PiezoOccupancySample,
} from '../fusedOccupancy'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const BASE = Date.UTC(2026, 8, 21, 14, 26, 0)

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
      certificatePhase: 'observing',
      certificate: null,
      lastCertificateInvalidationReason: 'pump_state_unsupported',
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
})
