/**
 * Owns the active alarm occurrence for each side.
 *
 * Scheduled, API, MQTT, HomeKit, and cover-button actions all use this
 * controller so a snooze restarts the same occurrence instead of creating a
 * detached timer that can overwrite a later alarm. State is persisted in
 * device_state and restored after a process restart.
 */
import { db } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { getSharedHardwareClient } from './sharedClient'
import type { HardwareClient } from './client'
import type { AlarmConfig, Side } from './types'

export type AlarmLifecycleState = 'idle' | 'ringing' | 'snoozed'

export interface AlarmStatus {
  state: AlarmLifecycleState
  active: boolean
  occurrenceId: string | null
  scheduleId: number | null
  scheduledFor: number | null
  snoozeUntil: number | null
  ringingUntil: number | null
  vibrationIntensity: number | null
  vibrationPattern: AlarmConfig['vibrationPattern'] | null
  duration: number | null
}

export interface AlarmRuntimeRecord {
  side: Side
  state: AlarmLifecycleState
  occurrenceId: string | null
  scheduleId: number | null
  scheduledFor: Date | null
  snoozedUntil: Date | null
  ringingUntil: Date | null
  config: AlarmConfig | null
}

type AlarmHardwareClient = Pick<HardwareClient, 'connect' | 'setAlarm' | 'clearAlarm'>

export interface StartAlarmOptions {
  client?: AlarmHardwareClient
  occurrenceId?: string
  scheduleId?: number | null
  scheduledFor?: Date
  broadcastOverlay?: Record<string, unknown>
}

export interface SnoozeAlarmOptions {
  client?: AlarmHardwareClient
  fallbackConfig?: AlarmConfig
}

export interface StopAlarmOptions {
  client?: AlarmHardwareClient
}

export interface AlarmLifecycleDeps {
  load: () => Promise<AlarmRuntimeRecord[]>
  persist: (record: AlarmRuntimeRecord) => Promise<void>
  getClient: () => AlarmHardwareClient
  notify: (record: AlarmRuntimeRecord, overlay?: Record<string, unknown>) => Promise<void>
  now: () => Date
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  retryDelayMs: number
}

const SIDES: readonly Side[] = ['left', 'right']
const DEFAULT_SNOOZE_SECONDS = 5 * 60
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000)
const CONTROLLER_KEY = '__sp_alarm_lifecycle_controller__'
const G = globalThis as Record<string, unknown>

function epochSeconds(value: Date | null): number | null {
  return value ? Math.floor(value.getTime() / 1000) : null
}

function idleRecord(side: Side): AlarmRuntimeRecord {
  return {
    side,
    state: 'idle',
    occurrenceId: null,
    scheduleId: null,
    scheduledFor: null,
    snoozedUntil: null,
    ringingUntil: null,
    config: null,
  }
}

function recordStatus(record: AlarmRuntimeRecord): AlarmStatus {
  return {
    state: record.state,
    active: record.state !== 'idle',
    occurrenceId: record.occurrenceId,
    scheduleId: record.scheduleId,
    scheduledFor: epochSeconds(record.scheduledFor),
    snoozeUntil: epochSeconds(record.snoozedUntil),
    ringingUntil: epochSeconds(record.ringingUntil),
    vibrationIntensity: record.config?.vibrationIntensity ?? null,
    vibrationPattern: record.config?.vibrationPattern ?? null,
    duration: record.config?.duration ?? null,
  }
}

export class AlarmLifecycleController {
  private readonly records = new Map<Side, AlarmRuntimeRecord>()
  private readonly timers = new Map<Side, ReturnType<typeof setTimeout>>()
  private readonly operations = new Map<Side, Promise<void>>()
  private initialized = false

  constructor(private readonly deps: AlarmLifecycleDeps) {}

  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      const records = await this.deps.load()
      for (const record of records) {
        this.records.set(record.side, record)
      }

      for (const side of SIDES) {
        const record = this.records.get(side)
        if (!record) continue

        if (record.state === 'snoozed' && (!record.occurrenceId || !record.snoozedUntil || !record.config)) {
          await this.transition(idleRecord(side))
          continue
        }

        if (record.state === 'ringing' && record.ringingUntil && record.ringingUntil.getTime() <= this.deps.now().getTime()) {
          await this.transition(idleRecord(side))
          continue
        }

        this.schedule(record)
      }

      this.initialized = true
    }
    catch (error) {
      for (const timer of this.timers.values()) this.deps.clearTimer(timer)
      this.timers.clear()
      this.records.clear()
      this.initialized = false
      throw error
    }
  }

  shutdown(): void {
    for (const timer of this.timers.values()) this.deps.clearTimer(timer)
    this.timers.clear()
    this.operations.clear()
    this.records.clear()
    this.initialized = false
  }

  getStatus(side: Side): AlarmStatus {
    return recordStatus(this.records.get(side) ?? idleRecord(side))
  }

  async start(side: Side, config: AlarmConfig, options: StartAlarmOptions = {}): Promise<AlarmStatus> {
    return this.enqueue(side, async () => {
      const client = options.client ?? this.deps.getClient()
      await client.connect()
      await client.setAlarm(side, config)

      const now = this.deps.now()
      const scheduledFor = options.scheduledFor ?? now
      const occurrenceId = options.occurrenceId
        ?? `${options.scheduleId == null ? 'manual' : `schedule-${options.scheduleId}`}-${scheduledFor.getTime()}`
      const ringingUntil = config.duration > 0
        ? new Date(now.getTime() + config.duration * 1000)
        : null

      const record: AlarmRuntimeRecord = {
        side,
        state: 'ringing',
        occurrenceId,
        scheduleId: options.scheduleId ?? null,
        scheduledFor,
        snoozedUntil: null,
        ringingUntil,
        config: { ...config },
      }
      await this.transition(record, options.broadcastOverlay)
      return recordStatus(record)
    })
  }

  async snooze(
    side: Side,
    durationSeconds = DEFAULT_SNOOZE_SECONDS,
    options: SnoozeAlarmOptions = {},
  ): Promise<AlarmStatus | null> {
    return this.enqueue(side, async () => {
      const current = this.records.get(side)
      if (!current || current.state === 'idle') return null

      const config = current.config ?? options.fallbackConfig ?? null
      if (!config) return null

      const client = options.client ?? this.deps.getClient()
      await client.connect()
      await client.clearAlarm(side)

      const now = this.deps.now()
      const duration = Math.min(MAX_TIMER_SECONDS, Math.max(60, Math.round(durationSeconds)))
      const record: AlarmRuntimeRecord = {
        ...current,
        state: 'snoozed',
        occurrenceId: current.occurrenceId ?? `legacy-${side}-${now.getTime()}`,
        scheduledFor: current.scheduledFor ?? now,
        snoozedUntil: new Date(now.getTime() + duration * 1000),
        ringingUntil: null,
        config: { ...config },
      }
      await this.transition(record)
      return recordStatus(record)
    })
  }

  async stop(side: Side, options: StopAlarmOptions = {}): Promise<AlarmStatus> {
    return this.enqueue(side, async () => {
      const current = this.records.get(side)
      const record = idleRecord(side)
      await this.persistWithRetry(record)

      const client = options.client ?? this.deps.getClient()
      try {
        await client.connect()
        await client.clearAlarm(side)
      }
      catch (error) {
        if (current?.state === 'snoozed') {
          await this.transition(record, undefined, false)
        }
        throw error
      }

      await this.transition(record, undefined, false)
      return recordStatus(record)
    })
  }

  private async transition(
    record: AlarmRuntimeRecord,
    overlay?: Record<string, unknown>,
    persist = true,
  ): Promise<void> {
    this.clearSideTimer(record.side)
    this.records.set(record.side, record)

    let persistenceError: unknown = null
    if (persist) {
      try {
        await this.persistWithRetry(record)
      }
      catch (error) {
        persistenceError = error
      }
    }

    try {
      await this.deps.notify(record, overlay)
    }
    catch (error) {
      console.error(`[alarm] failed to publish ${record.side} ${record.state} state:`, error)
    }

    this.schedule(record)

    if (persistenceError) {
      throw new Error(`Failed to persist ${record.side} alarm ${record.state} state`, {
        cause: persistenceError,
      })
    }
  }

  private schedule(record: AlarmRuntimeRecord): void {
    if (record.state === 'snoozed' && record.snoozedUntil && record.occurrenceId) {
      const delayMs = Math.max(0, record.snoozedUntil.getTime() - this.deps.now().getTime())
      const occurrenceId = record.occurrenceId
      const timer = this.deps.setTimer(() => {
        void this.enqueue(record.side, () => this.restartSnoozed(record.side, occurrenceId))
          .catch(error => console.error(`[alarm] snooze transition failed for ${record.side}:`, error))
      }, delayMs)
      this.timers.set(record.side, timer)
      return
    }

    if (record.state === 'ringing' && record.ringingUntil && record.occurrenceId) {
      const delayMs = Math.max(0, record.ringingUntil.getTime() - this.deps.now().getTime())
      const occurrenceId = record.occurrenceId
      const timer = this.deps.setTimer(() => {
        void this.enqueue(record.side, () => this.finishRinging(record.side, occurrenceId))
          .catch(error => console.error(`[alarm] ringing completion failed for ${record.side}:`, error))
      }, delayMs)
      this.timers.set(record.side, timer)
    }
  }

  private async restartSnoozed(side: Side, occurrenceId: string): Promise<void> {
    const current = this.records.get(side)
    if (!current || current.state !== 'snoozed' || current.occurrenceId !== occurrenceId || !current.config) return

    try {
      const client = this.deps.getClient()
      await client.connect()
      await client.setAlarm(side, current.config)
    }
    catch (error) {
      console.error(`[alarm] failed to restart snoozed alarm for ${side}:`, error)
      const retryAt = new Date(this.deps.now().getTime() + this.deps.retryDelayMs)
      await this.transition({ ...current, snoozedUntil: retryAt })
      return
    }

    const latest = this.records.get(side)
    if (!latest || latest.state !== 'snoozed' || latest.occurrenceId !== occurrenceId || !latest.config) return

    const now = this.deps.now()
    await this.transition({
      ...latest,
      state: 'ringing',
      snoozedUntil: null,
      ringingUntil: latest.config.duration > 0
        ? new Date(now.getTime() + latest.config.duration * 1000)
        : null,
    })
  }

  private async finishRinging(side: Side, occurrenceId: string): Promise<void> {
    const current = this.records.get(side)
    if (!current || current.state !== 'ringing' || current.occurrenceId !== occurrenceId) return
    await this.transition(idleRecord(side))
  }

  private clearSideTimer(side: Side): void {
    const timer = this.timers.get(side)
    if (timer) this.deps.clearTimer(timer)
    this.timers.delete(side)
  }

  private async persistWithRetry(record: AlarmRuntimeRecord): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.deps.persist(record)
        return
      }
      catch (error) {
        lastError = error
        console.error(`[alarm] failed to persist ${record.side} ${record.state} state (attempt ${attempt}/3):`, error)
      }
    }
    throw new Error(`Failed to persist ${record.side} alarm ${record.state} state`, {
      cause: lastError,
    })
  }

  private enqueue<T>(side: Side, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(side) ?? Promise.resolve()
    const result = previous
      .catch(() => undefined)
      .then(operation)
    const tracked = result.then(
      () => {
        if (this.operations.get(side) === tracked) this.operations.delete(side)
      },
      () => {
        if (this.operations.get(side) === tracked) this.operations.delete(side)
      },
    )
    this.operations.set(side, tracked)
    return result
  }
}

async function loadPersistedRecords(): Promise<AlarmRuntimeRecord[]> {
  const rows = db
    .select({
      side: deviceState.side,
      state: deviceState.alarmState,
      occurrenceId: deviceState.alarmOccurrenceId,
      scheduleId: deviceState.alarmScheduleId,
      scheduledFor: deviceState.alarmScheduledFor,
      snoozedUntil: deviceState.alarmSnoozedUntil,
      ringingUntil: deviceState.alarmRingingUntil,
      vibrationIntensity: deviceState.alarmVibrationIntensity,
      vibrationPattern: deviceState.alarmVibrationPattern,
      duration: deviceState.alarmDuration,
    })
    .from(deviceState)
    .all()

  return rows.map(row => ({
    side: row.side,
    state: row.state,
    occurrenceId: row.occurrenceId,
    scheduleId: row.scheduleId,
    scheduledFor: row.scheduledFor,
    snoozedUntil: row.snoozedUntil,
    ringingUntil: row.ringingUntil,
    config: row.vibrationIntensity != null && row.vibrationPattern != null && row.duration != null
      ? {
          vibrationIntensity: row.vibrationIntensity,
          vibrationPattern: row.vibrationPattern,
          duration: row.duration,
        }
      : null,
  }))
}

async function persistRecord(record: AlarmRuntimeRecord): Promise<void> {
  const updateValues = {
    isAlarmVibrating: record.state === 'ringing',
    alarmState: record.state,
    alarmOccurrenceId: record.occurrenceId,
    alarmScheduleId: record.scheduleId,
    alarmScheduledFor: record.scheduledFor,
    alarmSnoozedUntil: record.snoozedUntil,
    alarmRingingUntil: record.ringingUntil,
    alarmVibrationIntensity: record.config?.vibrationIntensity ?? null,
    alarmVibrationPattern: record.config?.vibrationPattern ?? null,
    alarmDuration: record.config?.duration ?? null,
    lastUpdated: new Date(),
  }
  const values = {
    side: record.side,
    ...updateValues,
  }

  await db
    .insert(deviceState)
    .values(values)
    .onConflictDoUpdate({
      target: deviceState.side,
      set: updateValues,
    })
}

async function notifyRecord(record: AlarmRuntimeRecord, overlay?: Record<string, unknown>): Promise<void> {
  const { broadcastMutationStatus } = await import('@/src/streaming/broadcastMutationStatus')
  broadcastMutationStatus(record.side, {
    ...overlay,
    isAlarmVibrating: record.state === 'ringing',
  })

  const { publishAlarmState } = await import('@/src/streaming/mqttBridge')
  publishAlarmState(record.side)
}

function defaultController(): AlarmLifecycleController {
  let controller = G[CONTROLLER_KEY] as AlarmLifecycleController | undefined
  if (!controller) {
    controller = new AlarmLifecycleController({
      load: loadPersistedRecords,
      persist: persistRecord,
      getClient: getSharedHardwareClient,
      notify: notifyRecord,
      now: () => new Date(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: timer => clearTimeout(timer),
      retryDelayMs: 5_000,
    })
    G[CONTROLLER_KEY] = controller
  }
  return controller
}

export async function initializeAlarmLifecycle(): Promise<void> {
  await defaultController().initialize()
}

export function shutdownAlarmLifecycle(): void {
  defaultController().shutdown()
}

export function getAlarmStatus(side: Side): AlarmStatus {
  return defaultController().getStatus(side)
}

export function getSnoozeStatus(side: Side): { active: boolean, snoozeUntil: number | null } {
  const status = getAlarmStatus(side)
  return {
    active: status.state === 'snoozed',
    snoozeUntil: status.snoozeUntil,
  }
}

export async function startAlarm(
  side: Side,
  config: AlarmConfig,
  options: StartAlarmOptions = {},
): Promise<AlarmStatus> {
  return defaultController().start(side, config, options)
}

export async function snoozeAlarm(
  side: Side,
  durationSeconds = DEFAULT_SNOOZE_SECONDS,
  options: SnoozeAlarmOptions = {},
): Promise<AlarmStatus | null> {
  return defaultController().snooze(side, durationSeconds, options)
}

export async function stopAlarm(side: Side, options: StopAlarmOptions = {}): Promise<AlarmStatus> {
  return defaultController().stop(side, options)
}
