import { randomUUID } from 'node:crypto'
import type { Side } from '@/src/hardware/types'

export const FUSED_OCCUPANCY_ALGORITHM = 'fused-occupancy-v2'

export type FusedOccupancyState = 'occupied' | 'clear' | 'unavailable'
export type FusedOccupancyClassification
  = | 'occupied_adaptive'
    | 'clear_adaptive'
    | 'clear_exit_certified'
    | 'unavailable'
export type FusedOccupancyReason
  = | 'adaptive_load'
    | 'adaptive_clear'
    | 'credible_entry'
    | 'exit_certified'
    | 'adaptive_source_missing'
    | 'adaptive_source_stale'
    | 'adaptive_source_future'
    | 'adaptive_timestamp_regressed'
    | 'source_read_failed'

export interface AdaptiveOccupancySample {
  side: Side
  sampleTimestampMs: number
  loadPresent: boolean
  classification: string
  score: number
  loadedChannels: number
  loadVelocityScore: number
  unloadVelocityScore: number
  entryVelocitySupported: boolean
  algorithmVersion: string
}

export interface PiezoOccupancySample {
  side: Side
  sampleTimestampMs: number
  present: boolean
  energy: number
  autocorrelationQuality: number
  enterThreshold: number
  exitThreshold: number
  decisionReason: string
  pumpMode: 'asymmetric' | 'symmetric' | null
}

export interface ExitCertificate {
  id: string
  basis: 'entry_transition' | 'sustained_baseline'
  transitionAtMs: number
  confirmedAtMs: number
  latestVerifiedAtMs: number
  adaptiveBaselineScore: number
  piezoBaselineEnergy: number
  piezoBaselineSource: 'configured_threshold' | 'entry_window' | 'observed'
  adaptiveCollapseRatio: number
  piezoCollapseRatio: number
}

export type CertificatePhase = 'observing' | 'armed' | 'confirming' | 'certified'

export interface ShortCycleDiagnostics {
  entryAtMs: number
  expiresAtMs: number
  adaptivePeakScore: number
  adaptivePeakLoadedChannels: number
  piezoPeakEnergy: number
  loadPresentObserved: boolean
  adaptiveCollapseAtMs: number | null
  adaptiveCollapseRatio: number | null
  blockedReason: string | null
}

export interface FusedOccupancyDecision {
  side: Side
  state: FusedOccupancyState
  occupied: boolean | null
  available: boolean
  classification: FusedOccupancyClassification
  reason: FusedOccupancyReason
  algorithm: typeof FUSED_OCCUPANCY_ALGORITHM
  semanticRevision: number
  decisionChangedAtMs: number
  stateSinceMs: number
  evidenceThroughMs: number | null
  validUntilMs: number | null
  provenanceEpoch: string
  certificatePhase: CertificatePhase
  certificate: ExitCertificate | null
  shortCycle: ShortCycleDiagnostics | null
  lastCertificateInvalidationReason: string | null
}

export interface FusedOccupancyInput {
  nowMs: number
  adaptive: AdaptiveOccupancySample | null
  piezo: PiezoOccupancySample | null
  sourceError?: boolean
}

export interface FusedOccupancyConfig {
  loadedBaselineWindowMs: number
  certificateConfirmationMs: number
  adaptiveMaximumAgeMs: number
  piezoMaximumAgeMs: number
  adaptiveMaximumGapMs: number
  piezoMaximumGapMs: number
  futureTimestampToleranceMs: number
  minimumAdaptiveBaselineSamples: number
  minimumPiezoBaselineSamples: number
  robustLoadedScore: number
  robustLoadedChannels: number
  capCollapseRatio: number
  capCollapseMaximumChannels: number
  piezoCollapseRatio: number
  piezoMaximumExitAutocorrelationQuality: number
  minimumPiezoBaselineToEnterThresholdRatio: number
  entryLoadVelocityScore: number
  independentEntryScore: number
  maintenanceMaximumScoreRatio: number
  maintenanceReboundScoreRatio: number
  maintenanceMaximumLoadedChannels: number
  armedTransitionMaximumAgeMs: number
  credibleEntryGuardMs: number
  shortCycleMaximumAgeMs: number
  shortCycleMinimumAgeMs: number
  shortCycleConfirmationMs: number
  shortCycleMinimumAdaptivePeakScore: number
  shortCycleMinimumAdaptivePeakChannels: number
  shortCycleCapCollapseRatio: number
  shortCycleMaximumLoadedChannels: number
  shortCycleMinimumUnloadVelocityScore: number
  shortCyclePiezoMaximumAgeBeforeEntryMs: number
  shortCyclePiezoLowEnergyAutocorrelationBypassRatio: number
  shortCycleMaximumExitAutocorrelationQuality: number
  piezoReturnMinimumEnergyToExitThresholdRatio: number
}

export const DEFAULT_FUSED_OCCUPANCY_CONFIG: FusedOccupancyConfig = {
  loadedBaselineWindowMs: 3 * 60_000,
  certificateConfirmationMs: 30_000,
  adaptiveMaximumAgeMs: 60_000,
  piezoMaximumAgeMs: 90_000,
  adaptiveMaximumGapMs: 30_000,
  piezoMaximumGapMs: 90_000,
  futureTimestampToleranceMs: 5_000,
  minimumAdaptiveBaselineSamples: 12,
  minimumPiezoBaselineSamples: 3,
  robustLoadedScore: 8,
  robustLoadedChannels: 2,
  capCollapseRatio: 0.4,
  capCollapseMaximumChannels: 1,
  piezoCollapseRatio: 0.25,
  piezoMaximumExitAutocorrelationQuality: 0.225,
  minimumPiezoBaselineToEnterThresholdRatio: 1,
  entryLoadVelocityScore: 3,
  independentEntryScore: 8,
  maintenanceMaximumScoreRatio: 0.6,
  maintenanceReboundScoreRatio: 0.75,
  maintenanceMaximumLoadedChannels: 2,
  armedTransitionMaximumAgeMs: 3 * 60_000,
  credibleEntryGuardMs: 30_000,
  shortCycleMaximumAgeMs: 5 * 60_000,
  shortCycleMinimumAgeMs: 10_000,
  shortCycleConfirmationMs: 10_000,
  shortCycleMinimumAdaptivePeakScore: 8,
  shortCycleMinimumAdaptivePeakChannels: 2,
  shortCycleCapCollapseRatio: 0.4,
  shortCycleMaximumLoadedChannels: 1,
  shortCycleMinimumUnloadVelocityScore: 3,
  shortCyclePiezoMaximumAgeBeforeEntryMs: 60_000,
  shortCyclePiezoLowEnergyAutocorrelationBypassRatio: 0.5,
  shortCycleMaximumExitAutocorrelationQuality: 0.25,
  piezoReturnMinimumEnergyToExitThresholdRatio: 0.05,
}

interface LoadedAdaptiveSample {
  timestampMs: number
  score: number
}

interface LoadedPiezoSample {
  timestampMs: number
  energy: number
}

interface ArmedBaseline {
  adaptiveScore: number
  piezoEnergy: number
  piezoBaselineSource: ExitCertificate['piezoBaselineSource']
  lastLoadedAtMs: number
}

interface CertificateCandidate {
  basis: ExitCertificate['basis']
  transitionAtMs: number
  confirmationMs: number
  adaptiveBaselineScore: number
  piezoBaselineEnergy: number
  piezoBaselineSource: ExitCertificate['piezoBaselineSource']
  adaptiveCollapseRatio: number
  piezoCollapseRatio: number
  adaptiveSampleTimestampAtStartMs: number
}

interface ShortCycleEpoch {
  entryAtMs: number
  expiresAtMs: number
  adaptivePeakScore: number
  adaptivePeakLoadedChannels: number
  piezoPeakEnergy: number
  loadPresentObserved: boolean
  adaptiveCollapseAtMs: number | null
  adaptiveCollapseRatio: number | null
  blockedReason: string | null
}

interface DecisionCore {
  state: FusedOccupancyState
  classification: FusedOccupancyClassification
  reason: FusedOccupancyReason
  evidenceThroughMs: number | null
  validUntilMs: number | null
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function isFiniteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

export class FusedOccupancySide {
  private readonly config: FusedOccupancyConfig
  private readonly provenanceEpoch: string
  private latestAdaptive: AdaptiveOccupancySample | null = null
  private latestPiezo: PiezoOccupancySample | null = null
  private lastAdaptiveTimestampMs: number | null = null
  private lastPiezoTimestampMs: number | null = null
  private loadedSinceMs: number | null = null
  private adaptiveBaselineSamples: LoadedAdaptiveSample[] = []
  private piezoBaselineSamples: LoadedPiezoSample[] = []
  private armedBaseline: ArmedBaseline | null = null
  private candidate: CertificateCandidate | null = null
  private shortCycleEpoch: ShortCycleEpoch | null = null
  private certificate: ExitCertificate | null = null
  private credibleEntryGuardUntilMs: number | null = null
  private lastCertificateInvalidationReason: string | null = null
  private semanticRevision = 0
  private currentDecision: FusedOccupancyDecision | null = null

  constructor(
    private readonly side: Side,
    options: {
      config?: Partial<FusedOccupancyConfig>
      provenanceEpoch?: string
    } = {},
  ) {
    this.config = {
      ...DEFAULT_FUSED_OCCUPANCY_CONFIG,
      ...options.config,
    }
    this.provenanceEpoch = options.provenanceEpoch ?? randomUUID()
  }

  update(input: FusedOccupancyInput): FusedOccupancyDecision {
    if (!isFiniteTimestamp(input.nowMs)) {
      throw new Error('nowMs must be a finite non-negative timestamp')
    }
    if (input.sourceError) {
      this.latestAdaptive = null
      this.latestPiezo = null
      this.invalidateTransitionState('source_read_failed')
      return this.emitDecision(input.nowMs, {
        state: 'unavailable',
        classification: 'unavailable',
        reason: 'source_read_failed',
        evidenceThroughMs: null,
        validUntilMs: null,
      })
    }

    const previousAdaptive = this.latestAdaptive
    const adaptiveIsNew = input.adaptive !== null
      && input.adaptive.sampleTimestampMs !== this.lastAdaptiveTimestampMs
    const piezoIsNew = input.piezo !== null
      && input.piezo.sampleTimestampMs !== this.lastPiezoTimestampMs
    const adaptiveFault = this.ingestAdaptive(input.adaptive)
    this.ingestPiezo(input.piezo)

    if (adaptiveFault) {
      return this.emitDecision(input.nowMs, {
        state: 'unavailable',
        classification: 'unavailable',
        reason: adaptiveFault,
        evidenceThroughMs: null,
        validUntilMs: null,
      })
    }

    const adaptive = this.latestAdaptive
    if (!adaptive) {
      this.invalidateTransitionState('adaptive_source_missing')
      return this.emitDecision(input.nowMs, {
        state: 'unavailable',
        classification: 'unavailable',
        reason: 'adaptive_source_missing',
        evidenceThroughMs: null,
        validUntilMs: null,
      })
    }

    const adaptiveAgeMs = input.nowMs - adaptive.sampleTimestampMs
    if (adaptiveAgeMs < -this.config.futureTimestampToleranceMs) {
      this.invalidateTransitionState('adaptive_source_future')
      return this.emitDecision(input.nowMs, {
        state: 'unavailable',
        classification: 'unavailable',
        reason: 'adaptive_source_future',
        evidenceThroughMs: adaptive.sampleTimestampMs,
        validUntilMs: null,
      })
    }
    if (adaptiveAgeMs > this.config.adaptiveMaximumAgeMs) {
      this.invalidateTransitionState('adaptive_source_stale')
      return this.emitDecision(input.nowMs, {
        state: 'unavailable',
        classification: 'unavailable',
        reason: 'adaptive_source_stale',
        evidenceThroughMs: adaptive.sampleTimestampMs,
        validUntilMs: adaptive.sampleTimestampMs + this.config.adaptiveMaximumAgeMs,
      })
    }

    const piezoFresh = this.isPiezoFresh(input.nowMs)
    const adaptiveContinuous
      = adaptiveAgeMs <= this.config.adaptiveMaximumGapMs
    const shortCycleEntry = adaptiveIsNew
      && (!this.armedBaseline || Boolean(this.certificate))
      && this.isShortCycleEntry(previousAdaptive, adaptive)
    const credibleEntry = Boolean(
      this.certificate || this.candidate,
    ) && (
      this.isCredibleEntry(adaptive)
      || this.isCrediblePiezoReturn(piezoIsNew)
    )
    if (credibleEntry) {
      this.invalidateTransitionState('credible_entry')
      this.credibleEntryGuardUntilMs
        = input.nowMs + this.config.credibleEntryGuardMs
    }
    if (shortCycleEntry) {
      this.startShortCycleEpoch(adaptive)
      this.credibleEntryGuardUntilMs
        = input.nowMs + this.config.credibleEntryGuardMs
    }
    this.observeShortCycleEvidence(adaptive, adaptiveIsNew, piezoIsNew)

    if (this.certificate) {
      if (!adaptiveContinuous) {
        this.invalidateCertificate('adaptive_source_gap')
      }
      else if (!piezoFresh) {
        this.invalidateCertificate('piezo_source_stale')
      }
      else if (
        this.certificate.basis === 'sustained_baseline'
        && !this.maintainsSustainedCertificate(adaptive)
      ) {
        this.invalidateCertificate('adaptive_rebound')
      }
      else {
        this.certificate = {
          ...this.certificate,
          latestVerifiedAtMs: Math.min(
            adaptive.sampleTimestampMs,
            this.latestPiezo?.sampleTimestampMs ?? adaptive.sampleTimestampMs,
          ),
        }
      }
    }

    if (!this.certificate) {
      this.advanceCertificateCandidates(
        input.nowMs,
        adaptiveContinuous,
        piezoFresh,
      )
    }

    const adaptiveValidUntilMs
      = adaptive.sampleTimestampMs + this.config.adaptiveMaximumAgeMs
    if (
      this.credibleEntryGuardUntilMs !== null
      && input.nowMs < this.credibleEntryGuardUntilMs
    ) {
      return this.emitDecision(input.nowMs, {
        state: 'occupied',
        classification: 'occupied_adaptive',
        reason: 'credible_entry',
        evidenceThroughMs: adaptive.sampleTimestampMs,
        validUntilMs: Math.min(
          adaptiveValidUntilMs,
          this.credibleEntryGuardUntilMs,
        ),
      })
    }
    this.credibleEntryGuardUntilMs = null

    if (this.certificate && piezoFresh && this.latestPiezo) {
      return this.emitDecision(input.nowMs, {
        state: 'clear',
        classification: 'clear_exit_certified',
        reason: 'exit_certified',
        evidenceThroughMs: Math.min(
          adaptive.sampleTimestampMs,
          this.latestPiezo.sampleTimestampMs,
        ),
        validUntilMs: Math.min(
          adaptiveValidUntilMs,
          this.latestPiezo.sampleTimestampMs + this.config.piezoMaximumAgeMs,
        ),
      })
    }

    return this.emitDecision(input.nowMs, adaptive.loadPresent
      ? {
          state: 'occupied',
          classification: 'occupied_adaptive',
          reason: 'adaptive_load',
          evidenceThroughMs: adaptive.sampleTimestampMs,
          validUntilMs: adaptiveValidUntilMs,
        }
      : {
          state: 'clear',
          classification: 'clear_adaptive',
          reason: 'adaptive_clear',
          evidenceThroughMs: adaptive.sampleTimestampMs,
          validUntilMs: adaptiveValidUntilMs,
        })
  }

  private ingestAdaptive(
    sample: AdaptiveOccupancySample | null,
  ): 'adaptive_timestamp_regressed' | null {
    if (!sample) {
      this.latestAdaptive = null
      return null
    }
    if (sample.side !== this.side) {
      throw new Error(`adaptive sample side ${sample.side} does not match ${this.side}`)
    }
    if (!isFiniteTimestamp(sample.sampleTimestampMs)) {
      throw new Error('adaptive sample timestamp must be finite and non-negative')
    }
    if (
      this.lastAdaptiveTimestampMs !== null
      && sample.sampleTimestampMs < this.lastAdaptiveTimestampMs
    ) {
      this.latestAdaptive = null
      this.invalidateTransitionState('adaptive_timestamp_regressed')
      return 'adaptive_timestamp_regressed'
    }

    const isNew = sample.sampleTimestampMs !== this.lastAdaptiveTimestampMs
    if (
      isNew
      && this.lastAdaptiveTimestampMs !== null
      && sample.sampleTimestampMs - this.lastAdaptiveTimestampMs
      > this.config.adaptiveMaximumGapMs
    ) {
      this.invalidateTransitionState('adaptive_source_gap')
    }

    this.latestAdaptive = sample
    if (!isNew) return null
    this.lastAdaptiveTimestampMs = sample.sampleTimestampMs

    const robustLoaded = this.isRobustLoaded(sample)
    if (robustLoaded) {
      if (this.loadedSinceMs === null) {
        this.loadedSinceMs = sample.sampleTimestampMs
      }
      this.adaptiveBaselineSamples.push({
        timestampMs: sample.sampleTimestampMs,
        score: sample.score,
      })
      this.trimBaselineSamples(sample.sampleTimestampMs)
    }
    else {
      this.loadedSinceMs = null
      if (!this.armedBaseline && !this.certificate) {
        this.adaptiveBaselineSamples = []
        this.piezoBaselineSamples = []
      }
    }

    return null
  }

  private ingestPiezo(sample: PiezoOccupancySample | null): void {
    if (!sample) {
      this.latestPiezo = null
      return
    }
    if (sample.side !== this.side) {
      throw new Error(`piezo sample side ${sample.side} does not match ${this.side}`)
    }
    if (!isFiniteTimestamp(sample.sampleTimestampMs)) {
      throw new Error('piezo sample timestamp must be finite and non-negative')
    }
    if (
      this.lastPiezoTimestampMs !== null
      && sample.sampleTimestampMs < this.lastPiezoTimestampMs
    ) {
      this.latestPiezo = null
      this.invalidateTransitionState('piezo_timestamp_regressed')
      return
    }

    const isNew = sample.sampleTimestampMs !== this.lastPiezoTimestampMs
    if (
      isNew
      && this.lastPiezoTimestampMs !== null
      && sample.sampleTimestampMs - this.lastPiezoTimestampMs
      > this.config.piezoMaximumGapMs
    ) {
      this.invalidateTransitionState('piezo_source_gap')
    }

    this.latestPiezo = sample
    if (!isNew) return
    this.lastPiezoTimestampMs = sample.sampleTimestampMs

    if (
      this.latestAdaptive
      && this.isRobustLoaded(this.latestAdaptive)
      && sample.present
      && sample.pumpMode === null
      && sample.energy >= sample.enterThreshold
    ) {
      this.piezoBaselineSamples.push({
        timestampMs: sample.sampleTimestampMs,
        energy: sample.energy,
      })
      this.trimBaselineSamples(sample.sampleTimestampMs)
    }
  }

  private trimBaselineSamples(nowMs: number): void {
    const cutoff = nowMs - this.config.loadedBaselineWindowMs
    this.adaptiveBaselineSamples
      = this.adaptiveBaselineSamples.filter(sample => sample.timestampMs >= cutoff)
    this.piezoBaselineSamples
      = this.piezoBaselineSamples.filter(sample => sample.timestampMs >= cutoff)
  }

  private isRobustLoaded(sample: AdaptiveOccupancySample): boolean {
    return sample.loadPresent
      && sample.score >= this.config.robustLoadedScore
      && sample.loadedChannels >= this.config.robustLoadedChannels
  }

  private isCredibleEntry(sample: AdaptiveOccupancySample): boolean {
    if (sample.loadVelocityScore >= this.config.entryLoadVelocityScore) return true
    if (
      sample.score >= this.config.independentEntryScore
      && sample.loadedChannels >= this.config.robustLoadedChannels
    ) {
      return true
    }
    if (!this.certificate) return false
    return sample.loadedChannels >= this.config.robustLoadedChannels
      && sample.score
      >= this.certificate.adaptiveBaselineScore
      * this.config.maintenanceReboundScoreRatio
  }

  private isCrediblePiezoReturn(isNew: boolean): boolean {
    const adaptive = this.latestAdaptive
    const piezo = this.latestPiezo
    const evidenceStartedAtMs = this.certificate?.confirmedAtMs
      ?? this.candidate?.transitionAtMs
    if (
      !isNew
      || !adaptive
      || !adaptive.entryVelocitySupported
      || !piezo
      || evidenceStartedAtMs === undefined
    ) {
      return false
    }
    if (piezo.sampleTimestampMs <= evidenceStartedAtMs) return false
    if (piezo.pumpMode !== null || !piezo.present) return false
    if (piezo.decisionReason === 'std_enter') {
      return piezo.energy >= piezo.enterThreshold
    }
    return piezo.decisionReason === 'autocorrelation_enter'
      && piezo.energy
      > piezo.exitThreshold
      * this.config.piezoReturnMinimumEnergyToExitThresholdRatio
  }

  private isShortCycleEntry(
    previous: AdaptiveOccupancySample | null,
    current: AdaptiveOccupancySample,
  ): boolean {
    if (!previous) return false
    if (
      current.sampleTimestampMs - previous.sampleTimestampMs
      > this.config.adaptiveMaximumGapMs
    ) {
      return false
    }
    if (
      current.loadVelocityScore < this.config.entryLoadVelocityScore
      || current.score < this.config.shortCycleMinimumAdaptivePeakScore
      || current.loadedChannels
      < this.config.shortCycleMinimumAdaptivePeakChannels
    ) {
      return false
    }
    return !previous.loadPresent
      || previous.score < this.config.shortCycleMinimumAdaptivePeakScore
      || previous.loadedChannels
      < this.config.shortCycleMinimumAdaptivePeakChannels
  }

  private startShortCycleEpoch(sample: AdaptiveOccupancySample): void {
    const piezo = this.latestPiezo
    const piezoRecentEnough = piezo
      && piezo.sampleTimestampMs
      >= sample.sampleTimestampMs
      - this.config.shortCyclePiezoMaximumAgeBeforeEntryMs
    this.shortCycleEpoch = {
      entryAtMs: sample.sampleTimestampMs,
      expiresAtMs:
        sample.sampleTimestampMs + this.config.shortCycleMaximumAgeMs,
      adaptivePeakScore: sample.score,
      adaptivePeakLoadedChannels: sample.loadedChannels,
      piezoPeakEnergy: piezoRecentEnough && piezo?.pumpMode === null
        ? piezo.energy
        : 0,
      loadPresentObserved: sample.loadPresent,
      adaptiveCollapseAtMs: null,
      adaptiveCollapseRatio: null,
      blockedReason: 'entry_epoch_too_young',
    }
    if (this.candidate?.basis === 'entry_transition') {
      this.candidate = null
    }
  }

  private observeShortCycleEvidence(
    adaptive: AdaptiveOccupancySample,
    adaptiveIsNew: boolean,
    piezoIsNew: boolean,
  ): void {
    const epoch = this.shortCycleEpoch
    if (!epoch) return
    if (adaptive.sampleTimestampMs > epoch.expiresAtMs) {
      if (this.candidate?.basis === 'entry_transition') {
        this.candidate = null
      }
      this.shortCycleEpoch = null
      return
    }
    if (adaptiveIsNew) {
      epoch.adaptivePeakScore = Math.max(
        epoch.adaptivePeakScore,
        adaptive.score,
      )
      epoch.adaptivePeakLoadedChannels = Math.max(
        epoch.adaptivePeakLoadedChannels,
        adaptive.loadedChannels,
      )
      epoch.loadPresentObserved
        ||= adaptive.loadPresent
    }
    const piezo = this.latestPiezo
    if (
      piezoIsNew
      && piezo
      && piezo.pumpMode === null
      && piezo.sampleTimestampMs
      >= epoch.entryAtMs
      - this.config.shortCyclePiezoMaximumAgeBeforeEntryMs
    ) {
      epoch.piezoPeakEnergy = Math.max(
        epoch.piezoPeakEnergy,
        piezo.energy,
      )
    }
  }

  private isPiezoFresh(nowMs: number): boolean {
    if (!this.latestPiezo) return false
    const ageMs = nowMs - this.latestPiezo.sampleTimestampMs
    return ageMs >= -this.config.futureTimestampToleranceMs
      && ageMs <= this.config.piezoMaximumAgeMs
  }

  private refreshArmedBaseline(): void {
    const adaptive = this.latestAdaptive
    const piezo = this.latestPiezo
    if (!adaptive || !piezo || this.loadedSinceMs === null) return
    if (
      adaptive.sampleTimestampMs - this.loadedSinceMs
      < this.config.loadedBaselineWindowMs
    ) {
      return
    }
    if (
      this.adaptiveBaselineSamples.length
      < this.config.minimumAdaptiveBaselineSamples
    ) {
      return
    }

    const adaptiveScore = median(
      this.adaptiveBaselineSamples.map(sample => sample.score),
    )
    const observedPiezoEnergy
      = this.piezoBaselineSamples.length
        >= this.config.minimumPiezoBaselineSamples
        ? median(this.piezoBaselineSamples.map(sample => sample.energy))
        : null
    const observedPiezoBaselineUsable = observedPiezoEnergy !== null
      && observedPiezoEnergy
      >= piezo.enterThreshold
      * this.config.minimumPiezoBaselineToEnterThresholdRatio

    this.armedBaseline = {
      adaptiveScore,
      piezoEnergy: observedPiezoBaselineUsable
        ? observedPiezoEnergy
        : piezo.enterThreshold,
      piezoBaselineSource: observedPiezoBaselineUsable
        ? 'observed'
        : 'configured_threshold',
      lastLoadedAtMs: adaptive.sampleTimestampMs,
    }
    this.candidate = null
  }

  private advanceCertificateCandidates(
    nowMs: number,
    adaptiveContinuous: boolean,
    piezoFresh: boolean,
  ): void {
    this.advanceShortCycleCandidate(
      nowMs,
      adaptiveContinuous,
      piezoFresh,
    )
    if (
      this.certificate
      || this.candidate?.basis === 'entry_transition'
    ) {
      return
    }
    this.advanceSustainedCertificateCandidate(
      nowMs,
      adaptiveContinuous,
      piezoFresh,
    )
  }

  private advanceShortCycleCandidate(
    nowMs: number,
    adaptiveContinuous: boolean,
    piezoFresh: boolean,
  ): void {
    const adaptive = this.latestAdaptive
    const piezo = this.latestPiezo
    const epoch = this.shortCycleEpoch
    if (!adaptive || !epoch) return

    const clearCandidate = () => {
      if (this.candidate?.basis === 'entry_transition') {
        this.candidate = null
      }
    }
    const block = (reason: string) => {
      clearCandidate()
      epoch.blockedReason = reason
    }

    if (nowMs > epoch.expiresAtMs) {
      clearCandidate()
      this.shortCycleEpoch = null
      return
    }
    if (!adaptiveContinuous) {
      block('adaptive_source_gap')
      return
    }
    if (!epoch.loadPresentObserved) {
      block('adaptive_load_not_confirmed')
      return
    }
    if (!adaptive.loadPresent) {
      clearCandidate()
      this.shortCycleEpoch = null
      return
    }
    if (
      adaptive.sampleTimestampMs - epoch.entryAtMs
      < this.config.shortCycleMinimumAgeMs
    ) {
      block('entry_epoch_too_young')
      return
    }
    if (
      epoch.adaptivePeakScore
      < this.config.shortCycleMinimumAdaptivePeakScore
      || epoch.adaptivePeakLoadedChannels
      < this.config.shortCycleMinimumAdaptivePeakChannels
    ) {
      block('adaptive_entry_too_weak')
      return
    }
    const adaptiveCollapseRatio
      = adaptive.score / epoch.adaptivePeakScore
    const adaptiveCollapsed = !(
      adaptiveCollapseRatio > this.config.shortCycleCapCollapseRatio
      || adaptive.loadedChannels
      > this.config.shortCycleMaximumLoadedChannels
      || adaptive.loadVelocityScore
      >= this.config.entryLoadVelocityScore
    )
    if (!adaptiveCollapsed) {
      epoch.adaptiveCollapseAtMs = null
      epoch.adaptiveCollapseRatio = null
      block('adaptive_not_collapsed')
      return
    }
    if (
      epoch.adaptiveCollapseAtMs === null
      && adaptive.unloadVelocityScore
      >= this.config.shortCycleMinimumUnloadVelocityScore
    ) {
      epoch.adaptiveCollapseAtMs = adaptive.sampleTimestampMs
      epoch.adaptiveCollapseRatio = adaptiveCollapseRatio
    }
    if (epoch.adaptiveCollapseAtMs === null) {
      block('adaptive_unload_too_weak')
      return
    }
    if (!piezoFresh || !piezo) {
      block('piezo_source_stale')
      return
    }
    if (
      piezo.sampleTimestampMs
      < epoch.entryAtMs
      - this.config.shortCyclePiezoMaximumAgeBeforeEntryMs
    ) {
      block('piezo_before_entry_window')
      return
    }
    if (piezo.pumpMode !== null) {
      block('pump_state_unsupported')
      return
    }
    const piezoBaselineEnergy = Math.max(
      epoch.piezoPeakEnergy,
      piezo.energy,
      1,
    )
    const piezoCollapseRatio
      = piezo.energy / piezoBaselineEnergy
    if (this.candidate?.basis === 'entry_transition') {
      // Cap continuity confirms the exit; uncorroborated piezo can be exit or
      // opposite-side movement. Pump and credible-return gates run above.
      epoch.blockedReason = null
      this.confirmCandidate(nowMs, adaptive, piezo)
      return
    }
    const piezoQuiet = piezo.energy <= piezo.exitThreshold
      && (
        piezo.autocorrelationQuality
        <= this.config.shortCycleMaximumExitAutocorrelationQuality
        || piezo.energy
        <= piezo.exitThreshold
        * this.config.shortCyclePiezoLowEnergyAutocorrelationBypassRatio
      )
    if (!piezoQuiet) {
      block('piezo_not_quiet')
      return
    }

    epoch.blockedReason = null
    this.candidate = {
      basis: 'entry_transition',
      transitionAtMs: Math.max(
        epoch.adaptiveCollapseAtMs,
        piezo.sampleTimestampMs,
      ),
      confirmationMs: this.config.shortCycleConfirmationMs,
      adaptiveBaselineScore: epoch.adaptivePeakScore,
      piezoBaselineEnergy,
      piezoBaselineSource: 'entry_window',
      adaptiveCollapseRatio:
        epoch.adaptiveCollapseRatio ?? adaptiveCollapseRatio,
      piezoCollapseRatio,
      adaptiveSampleTimestampAtStartMs: adaptive.sampleTimestampMs,
    }
  }

  private advanceSustainedCertificateCandidate(
    nowMs: number,
    adaptiveContinuous: boolean,
    piezoFresh: boolean,
  ): void {
    const adaptive = this.latestAdaptive
    const piezo = this.latestPiezo
    if (!adaptive) return

    if (
      this.isRobustLoaded(adaptive)
      && adaptiveContinuous
      && piezoFresh
    ) {
      this.refreshArmedBaseline()
      return
    }
    if (this.isRobustLoaded(adaptive)) return
    if (!this.armedBaseline || !adaptiveContinuous || !piezoFresh || !piezo) {
      if (this.candidate?.basis === 'sustained_baseline') {
        this.candidate = null
      }
      return
    }
    if (
      this.candidate?.basis !== 'sustained_baseline'
      && adaptive.sampleTimestampMs - this.armedBaseline.lastLoadedAtMs
      > this.config.armedTransitionMaximumAgeMs
    ) {
      this.invalidateSustainedTransition('armed_transition_expired')
      return
    }
    if (piezo.pumpMode !== null) {
      if (this.candidate?.basis === 'sustained_baseline') {
        this.candidate = null
      }
      return
    }

    const adaptiveCollapseRatio
      = adaptive.score / this.armedBaseline.adaptiveScore
    const piezoCollapseRatio
      = piezo.energy / this.armedBaseline.piezoEnergy
    const collapsed = adaptiveCollapseRatio <= this.config.capCollapseRatio
      && adaptive.loadedChannels <= this.config.capCollapseMaximumChannels
      && adaptive.loadVelocityScore < this.config.entryLoadVelocityScore
      && piezo.energy <= piezo.exitThreshold
      && piezo.autocorrelationQuality
      <= this.config.piezoMaximumExitAutocorrelationQuality
      && (
        this.armedBaseline.piezoBaselineSource === 'configured_threshold'
        || piezoCollapseRatio <= this.config.piezoCollapseRatio
      )

    if (!collapsed) {
      if (this.candidate?.basis === 'sustained_baseline') {
        this.candidate = null
      }
      return
    }

    if (this.candidate?.basis !== 'sustained_baseline') {
      this.candidate = {
        basis: 'sustained_baseline',
        transitionAtMs: Math.max(
          adaptive.sampleTimestampMs,
          piezo.sampleTimestampMs,
        ),
        confirmationMs: this.config.certificateConfirmationMs,
        adaptiveBaselineScore: this.armedBaseline.adaptiveScore,
        piezoBaselineEnergy: this.armedBaseline.piezoEnergy,
        piezoBaselineSource: this.armedBaseline.piezoBaselineSource,
        adaptiveCollapseRatio,
        piezoCollapseRatio,
        adaptiveSampleTimestampAtStartMs: adaptive.sampleTimestampMs,
      }
      return
    }
    this.confirmCandidate(nowMs, adaptive, piezo)
  }

  private confirmCandidate(
    nowMs: number,
    adaptive: AdaptiveOccupancySample,
    piezo: PiezoOccupancySample,
  ): void {
    const candidate = this.candidate
    if (!candidate) return
    if (
      nowMs - candidate.transitionAtMs
      < candidate.confirmationMs
    ) {
      return
    }
    if (
      adaptive.sampleTimestampMs
      <= candidate.adaptiveSampleTimestampAtStartMs
    ) {
      return
    }

    this.certificate = {
      id: `${this.side}-${this.provenanceEpoch}-${candidate.transitionAtMs}`,
      basis: candidate.basis,
      transitionAtMs: candidate.transitionAtMs,
      confirmedAtMs: nowMs,
      latestVerifiedAtMs: Math.min(
        adaptive.sampleTimestampMs,
        piezo.sampleTimestampMs,
      ),
      adaptiveBaselineScore: candidate.adaptiveBaselineScore,
      piezoBaselineEnergy: candidate.piezoBaselineEnergy,
      piezoBaselineSource: candidate.piezoBaselineSource,
      adaptiveCollapseRatio: candidate.adaptiveCollapseRatio,
      piezoCollapseRatio: candidate.piezoCollapseRatio,
    }
    this.lastCertificateInvalidationReason = null
    this.candidate = null
    this.shortCycleEpoch = null
  }

  private maintainsSustainedCertificate(
    sample: AdaptiveOccupancySample,
  ): boolean {
    const certificate = this.certificate
    if (!certificate) return false
    if (
      sample.loadedChannels > this.config.maintenanceMaximumLoadedChannels
    ) {
      return false
    }
    return sample.score
      <= certificate.adaptiveBaselineScore
      * this.config.maintenanceMaximumScoreRatio
  }

  private invalidateCertificate(reason: string): void {
    if (this.certificate) {
      this.lastCertificateInvalidationReason = reason
    }
    this.certificate = null
    this.candidate = null
    this.shortCycleEpoch = null
    this.armedBaseline = null
    this.loadedSinceMs = null
    this.adaptiveBaselineSamples = []
    this.piezoBaselineSamples = []
  }

  private invalidateSustainedTransition(reason: string): void {
    if (
      this.armedBaseline
      || this.candidate?.basis === 'sustained_baseline'
    ) {
      this.lastCertificateInvalidationReason = reason
    }
    if (this.candidate?.basis === 'sustained_baseline') {
      this.candidate = null
    }
    this.armedBaseline = null
    this.loadedSinceMs = null
    this.adaptiveBaselineSamples = []
    this.piezoBaselineSamples = []
  }

  private invalidateTransitionState(reason: string): void {
    if (
      this.certificate
      || this.candidate
      || this.armedBaseline
      || this.shortCycleEpoch
    ) {
      this.lastCertificateInvalidationReason = reason
    }
    this.certificate = null
    this.candidate = null
    this.shortCycleEpoch = null
    this.armedBaseline = null
    this.loadedSinceMs = null
    this.adaptiveBaselineSamples = []
    this.piezoBaselineSamples = []
  }

  private certificatePhase(): CertificatePhase {
    if (this.certificate) return 'certified'
    if (this.candidate) return 'confirming'
    if (this.armedBaseline || this.shortCycleEpoch) return 'armed'
    return 'observing'
  }

  private shortCycleDiagnostics(): ShortCycleDiagnostics | null {
    const epoch = this.shortCycleEpoch
    if (!epoch) return null
    return { ...epoch }
  }

  private emitDecision(
    nowMs: number,
    core: DecisionCore,
  ): FusedOccupancyDecision {
    const phase = this.certificatePhase()
    const semanticKey = [
      core.state,
      core.classification,
      core.reason,
      phase,
      this.certificate?.id ?? '',
      this.certificate?.basis ?? '',
      this.shortCycleEpoch?.entryAtMs ?? '',
      this.shortCycleEpoch?.adaptiveCollapseAtMs ?? '',
      this.shortCycleEpoch?.blockedReason ?? '',
      this.lastCertificateInvalidationReason ?? '',
    ].join('|')
    const previousKey = this.currentDecision
      ? [
          this.currentDecision.state,
          this.currentDecision.classification,
          this.currentDecision.reason,
          this.currentDecision.certificatePhase,
          this.currentDecision.certificate?.id ?? '',
          this.currentDecision.certificate?.basis ?? '',
          this.currentDecision.shortCycle?.entryAtMs ?? '',
          this.currentDecision.shortCycle?.adaptiveCollapseAtMs ?? '',
          this.currentDecision.shortCycle?.blockedReason ?? '',
          this.currentDecision.lastCertificateInvalidationReason ?? '',
        ].join('|')
      : null
    if (semanticKey !== previousKey) {
      this.semanticRevision += 1
    }

    const stateSinceMs = this.currentDecision?.state === core.state
      ? this.currentDecision.stateSinceMs
      : nowMs
    const decisionChangedAtMs = semanticKey === previousKey
      ? this.currentDecision?.decisionChangedAtMs ?? nowMs
      : nowMs
    const decision: FusedOccupancyDecision = {
      side: this.side,
      state: core.state,
      occupied: core.state === 'unavailable'
        ? null
        : core.state === 'occupied',
      available: core.state !== 'unavailable',
      classification: core.classification,
      reason: core.reason,
      algorithm: FUSED_OCCUPANCY_ALGORITHM,
      semanticRevision: this.semanticRevision,
      decisionChangedAtMs,
      stateSinceMs,
      evidenceThroughMs: core.evidenceThroughMs,
      validUntilMs: core.validUntilMs,
      provenanceEpoch: this.provenanceEpoch,
      certificatePhase: phase,
      certificate: this.certificate,
      shortCycle: this.shortCycleDiagnostics(),
      lastCertificateInvalidationReason:
        this.lastCertificateInvalidationReason,
    }
    this.currentDecision = decision
    return decision
  }
}

export class FusedOccupancyProvider {
  private readonly sides: Record<Side, FusedOccupancySide>

  constructor(options: {
    config?: Partial<FusedOccupancyConfig>
    provenanceEpoch?: string
  } = {}) {
    const epoch = options.provenanceEpoch ?? randomUUID()
    this.sides = {
      left: new FusedOccupancySide('left', {
        config: options.config,
        provenanceEpoch: epoch,
      }),
      right: new FusedOccupancySide('right', {
        config: options.config,
        provenanceEpoch: epoch,
      }),
    }
  }

  update(side: Side, input: FusedOccupancyInput): FusedOccupancyDecision {
    return this.sides[side].update(input)
  }
}
