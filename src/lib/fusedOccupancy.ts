import { randomUUID } from 'node:crypto'
import type { Side } from '@/src/hardware/types'

export const FUSED_OCCUPANCY_ALGORITHM = 'fused-occupancy-v1'

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
  transitionAtMs: number
  confirmedAtMs: number
  latestVerifiedAtMs: number
  adaptiveBaselineScore: number
  piezoBaselineEnergy: number
  adaptiveCollapseRatio: number
  piezoCollapseRatio: number
}

export type CertificatePhase = 'observing' | 'armed' | 'confirming' | 'certified'

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
  armedTransitionMaximumAgeMs: 60_000,
  credibleEntryGuardMs: 30_000,
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
  lastLoadedAtMs: number
}

interface CertificateCandidate {
  transitionAtMs: number
  adaptiveCollapseRatio: number
  piezoCollapseRatio: number
  adaptiveSampleTimestampAtStartMs: number
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
    const credibleEntry = Boolean(
      this.certificate || this.candidate,
    ) && this.isCredibleEntry(adaptive)
    if (credibleEntry) {
      this.invalidateTransitionState('credible_entry')
      this.credibleEntryGuardUntilMs
        = input.nowMs + this.config.credibleEntryGuardMs
    }

    if (this.certificate) {
      if (!adaptiveContinuous) {
        this.invalidateCertificate('adaptive_source_gap')
      }
      else if (!piezoFresh) {
        this.invalidateCertificate('piezo_source_stale')
      }
      else if (this.latestPiezo?.pumpMode !== null) {
        this.invalidateCertificate('pump_state_unsupported')
      }
      else if (!this.maintainsCertificate(adaptive)) {
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
      this.advanceCertificateCandidate(
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
      || this.piezoBaselineSamples.length
      < this.config.minimumPiezoBaselineSamples
    ) {
      return
    }

    const adaptiveScore = median(
      this.adaptiveBaselineSamples.map(sample => sample.score),
    )
    const piezoEnergy = median(
      this.piezoBaselineSamples.map(sample => sample.energy),
    )
    if (
      piezoEnergy
      < piezo.enterThreshold
      * this.config.minimumPiezoBaselineToEnterThresholdRatio
    ) {
      return
    }

    this.armedBaseline = {
      adaptiveScore,
      piezoEnergy,
      lastLoadedAtMs: adaptive.sampleTimestampMs,
    }
    this.candidate = null
  }

  private advanceCertificateCandidate(
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
      this.candidate = null
      return
    }
    if (
      !this.candidate
      && adaptive.sampleTimestampMs - this.armedBaseline.lastLoadedAtMs
      > this.config.armedTransitionMaximumAgeMs
    ) {
      this.invalidateTransitionState('armed_transition_expired')
      return
    }
    if (piezo.pumpMode !== null) {
      this.invalidateTransitionState('pump_state_unsupported')
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
      && piezoCollapseRatio <= this.config.piezoCollapseRatio

    if (!collapsed) {
      this.candidate = null
      return
    }

    if (!this.candidate) {
      this.candidate = {
        transitionAtMs: Math.max(
          adaptive.sampleTimestampMs,
          piezo.sampleTimestampMs,
        ),
        adaptiveCollapseRatio,
        piezoCollapseRatio,
        adaptiveSampleTimestampAtStartMs: adaptive.sampleTimestampMs,
      }
      return
    }
    if (
      nowMs - this.candidate.transitionAtMs
      < this.config.certificateConfirmationMs
    ) {
      return
    }
    if (
      adaptive.sampleTimestampMs
      <= this.candidate.adaptiveSampleTimestampAtStartMs
    ) {
      return
    }

    this.certificate = {
      id: `${this.side}-${this.provenanceEpoch}-${this.candidate.transitionAtMs}`,
      transitionAtMs: this.candidate.transitionAtMs,
      confirmedAtMs: nowMs,
      latestVerifiedAtMs: Math.min(
        adaptive.sampleTimestampMs,
        piezo.sampleTimestampMs,
      ),
      adaptiveBaselineScore: this.armedBaseline.adaptiveScore,
      piezoBaselineEnergy: this.armedBaseline.piezoEnergy,
      adaptiveCollapseRatio: this.candidate.adaptiveCollapseRatio,
      piezoCollapseRatio: this.candidate.piezoCollapseRatio,
    }
    this.lastCertificateInvalidationReason = null
    this.candidate = null
  }

  private maintainsCertificate(sample: AdaptiveOccupancySample): boolean {
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
    this.armedBaseline = null
    this.loadedSinceMs = null
    this.adaptiveBaselineSamples = []
    this.piezoBaselineSamples = []
  }

  private invalidateTransitionState(reason: string): void {
    if (this.certificate || this.candidate || this.armedBaseline) {
      this.lastCertificateInvalidationReason = reason
    }
    this.certificate = null
    this.candidate = null
    this.armedBaseline = null
    this.loadedSinceMs = null
    this.adaptiveBaselineSamples = []
    this.piezoBaselineSamples = []
  }

  private certificatePhase(): CertificatePhase {
    if (this.certificate) return 'certified'
    if (this.candidate) return 'confirming'
    if (this.armedBaseline) return 'armed'
    return 'observing'
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
      this.lastCertificateInvalidationReason ?? '',
    ].join('|')
    const previousKey = this.currentDecision
      ? [
          this.currentDecision.state,
          this.currentDecision.classification,
          this.currentDecision.reason,
          this.currentDecision.certificatePhase,
          this.currentDecision.certificate?.id ?? '',
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
