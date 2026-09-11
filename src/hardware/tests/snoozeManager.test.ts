import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AlarmLifecycleController,
  type AlarmLifecycleDeps,
  type AlarmRuntimeRecord,
} from '../snoozeManager'
import type { AlarmConfig, Side } from '../types'

const NOW = new Date('2026-07-28T06:30:00-07:00')
const CONFIG: AlarmConfig = {
  vibrationIntensity: 90,
  vibrationPattern: 'rise',
  duration: 120,
}

function snoozedRecord(overrides: Partial<AlarmRuntimeRecord> = {}): AlarmRuntimeRecord {
  return {
    side: 'right',
    state: 'snoozed',
    occurrenceId: 'schedule-42-1785255000000',
    scheduleId: 42,
    scheduledFor: new Date(NOW),
    snoozedUntil: new Date(NOW.getTime() + 5 * 60_000),
    ringingUntil: null,
    config: { ...CONFIG },
    ...overrides,
  }
}

describe('AlarmLifecycleController', () => {
  let loaded: AlarmRuntimeRecord[]
  let persisted: AlarmRuntimeRecord[]
  let controller: AlarmLifecycleController
  let client: {
    connect: Mock<() => Promise<void>>
    setAlarm: Mock<(side: Side, config: AlarmConfig) => Promise<void>>
    clearAlarm: Mock<(side: Side) => Promise<void>>
  }
  let load: Mock<() => Promise<AlarmRuntimeRecord[]>>
  let persist: Mock<(record: AlarmRuntimeRecord) => Promise<void>>
  let notify: Mock<(record: AlarmRuntimeRecord, overlay?: Record<string, unknown>) => Promise<void>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    loaded = []
    persisted = []
    client = {
      connect: vi.fn(async () => undefined),
      setAlarm: vi.fn(async () => undefined),
      clearAlarm: vi.fn(async () => undefined),
    }
    load = vi.fn(async () => loaded)
    persist = vi.fn(async (record) => {
      persisted = [
        ...persisted.filter(item => item.side !== record.side),
        record,
      ]
    })
    notify = vi.fn(async () => undefined)

    const deps: AlarmLifecycleDeps = {
      load,
      persist,
      getClient: () => client,
      notify,
      now: () => new Date(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: timer => clearTimeout(timer),
      retryDelayMs: 5_000,
    }
    controller = new AlarmLifecycleController(deps)
  })

  afterEach(() => {
    controller.shutdown()
    vi.useRealTimers()
  })

  it('starts idle on both sides', () => {
    expect(controller.getStatus('left')).toMatchObject({ state: 'idle', active: false })
    expect(controller.getStatus('right')).toMatchObject({ state: 'idle', active: false })
  })

  it('tracks a scheduled occurrence and expires it after its vibration duration', async () => {
    await controller.start('right', CONFIG, {
      scheduleId: 42,
      scheduledFor: NOW,
    })

    expect(client.setAlarm).toHaveBeenCalledWith('right', CONFIG)
    expect(controller.getStatus('right')).toMatchObject({
      state: 'ringing',
      active: true,
      scheduleId: 42,
      scheduledFor: Math.floor(NOW.getTime() / 1000),
      duration: 120,
    })

    await vi.advanceTimersByTimeAsync(120_000)

    expect(controller.getStatus('right')).toMatchObject({ state: 'idle', active: false })
    expect(persisted.find(record => record.side === 'right')?.state).toBe('idle')
  })

  it('snoozes the current occurrence for five minutes and restores its original config', async () => {
    await controller.start('right', CONFIG, { scheduleId: 42, scheduledFor: NOW })
    const result = await controller.snooze('right', 300)

    expect(client.clearAlarm).toHaveBeenCalledWith('right')
    expect(result).toMatchObject({
      state: 'snoozed',
      scheduleId: 42,
      snoozeUntil: Math.floor((NOW.getTime() + 300_000) / 1000),
    })

    client.setAlarm.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)

    expect(client.setAlarm).toHaveBeenCalledWith('right', CONFIG)
    expect(controller.getStatus('right')).toMatchObject({
      state: 'ringing',
      scheduleId: 42,
      snoozeUntil: null,
    })
  })

  it('re-snoozes the same occurrence from the new request time', async () => {
    await controller.start('right', { ...CONFIG, duration: 0 }, { scheduleId: 42, scheduledFor: NOW })
    await controller.snooze('right', 300)
    await vi.advanceTimersByTimeAsync(120_000)
    await controller.snooze('right', 300)

    client.setAlarm.mockClear()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(client.setAlarm).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(client.setAlarm).toHaveBeenCalledOnce()
  })

  it('stops a snoozed occurrence and prevents it from restarting', async () => {
    await controller.start('right', CONFIG, { scheduleId: 42, scheduledFor: NOW })
    await controller.snooze('right', 300)
    await controller.stop('right')

    client.setAlarm.mockClear()
    await vi.advanceTimersByTimeAsync(300_000)

    expect(client.setAlarm).not.toHaveBeenCalled()
    expect(controller.getStatus('right')).toMatchObject({ state: 'idle', active: false })
  })

  it('keeps left and right occurrences independent', async () => {
    await controller.start('left', { ...CONFIG, duration: 0 }, { scheduleId: 1, scheduledFor: NOW })
    await controller.start('right', { ...CONFIG, duration: 0 }, { scheduleId: 2, scheduledFor: NOW })
    await controller.snooze('right', 300)

    expect(controller.getStatus('left').state).toBe('ringing')
    expect(controller.getStatus('right').state).toBe('snoozed')
  })

  it('lets a newer scheduled alarm replace an older snoozed occurrence', async () => {
    await controller.start('right', { ...CONFIG, duration: 0 }, { scheduleId: 42, scheduledFor: NOW })
    await controller.snooze('right', 1_800)

    const later = new Date(NOW.getTime() + 30 * 60_000)
    vi.setSystemTime(later)
    await controller.start('right', { ...CONFIG, duration: 0 }, { scheduleId: 43, scheduledFor: later })

    client.setAlarm.mockClear()
    await vi.advanceTimersByTimeAsync(1_800_000)

    expect(client.setAlarm).not.toHaveBeenCalled()
    expect(controller.getStatus('right')).toMatchObject({
      state: 'ringing',
      scheduleId: 43,
    })
  })

  it('serializes a stop behind an in-flight snooze restart', async () => {
    await controller.start('right', { ...CONFIG, duration: 0 }, { scheduleId: 42, scheduledFor: NOW })
    await controller.snooze('right', 60)

    let releaseRestart: (() => void) | undefined
    client.setAlarm.mockClear()
    client.setAlarm.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseRestart = resolve
    }))
    await vi.advanceTimersByTimeAsync(60_000)

    const stopPromise = controller.stop('right')
    expect(client.clearAlarm).toHaveBeenCalledTimes(1)

    releaseRestart?.()
    await stopPromise

    expect(controller.getStatus('right')).toMatchObject({ state: 'idle', active: false })
    expect(client.clearAlarm).toHaveBeenCalledTimes(2)
  })

  it('restores a persisted snooze after restart', async () => {
    loaded = [snoozedRecord()]
    await controller.initialize()

    expect(controller.getStatus('right').state).toBe('snoozed')
    await vi.advanceTimersByTimeAsync(300_000)

    expect(client.setAlarm).toHaveBeenCalledWith('right', CONFIG)
    expect(controller.getStatus('right').state).toBe('ringing')
  })

  it('allows initialization to retry after a transient load failure', async () => {
    load.mockRejectedValueOnce(new Error('database busy'))
    await expect(controller.initialize()).rejects.toThrow('database busy')

    loaded = [snoozedRecord()]
    await controller.initialize()

    expect(load).toHaveBeenCalledTimes(2)
    expect(controller.getStatus('right').state).toBe('snoozed')
  })

  it('keeps a failed snooze restart active and retries', async () => {
    loaded = [snoozedRecord({ snoozedUntil: new Date(NOW.getTime() + 1_000) })]
    client.setAlarm.mockRejectedValueOnce(new Error('hardware unavailable'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await controller.initialize()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(controller.getStatus('right')).toMatchObject({
      state: 'snoozed',
      snoozeUntil: Math.floor((NOW.getTime() + 6_000) / 1000),
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.setAlarm).toHaveBeenCalledTimes(2)
    expect(controller.getStatus('right').state).toBe('ringing')
    error.mockRestore()
  })

  it('rejects snooze when no alarm occurrence is active', async () => {
    expect(await controller.snooze('left', 300)).toBeNull()
    expect(client.clearAlarm).not.toHaveBeenCalled()
  })

  it('does not report success when lifecycle state cannot be persisted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    persist.mockRejectedValue(new Error('database read-only'))

    await expect(controller.start('left', CONFIG)).rejects.toThrow(/Failed to persist left alarm ringing state/)

    expect(persist).toHaveBeenCalledTimes(3)
    expect(controller.getStatus('left').state).toBe('ringing')
    error.mockRestore()
  })

  it('does not clear hardware when an idle dismissal tombstone cannot be persisted', async () => {
    await controller.start('right', { ...CONFIG, duration: 0 })
    client.clearAlarm.mockClear()
    persist.mockRejectedValue(new Error('database read-only'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(controller.stop('right')).rejects.toThrow(/Failed to persist right alarm idle state/)

    expect(client.clearAlarm).not.toHaveBeenCalled()
    expect(controller.getStatus('right').state).toBe('ringing')
    error.mockRestore()
  })

  it('persists idle before attempting the hardware clear', async () => {
    await controller.start('right', { ...CONFIG, duration: 60 })
    client.clearAlarm.mockRejectedValueOnce(new Error('hardware unavailable'))

    await expect(controller.stop('right')).rejects.toThrow('hardware unavailable')

    expect(persisted.find(record => record.side === 'right')?.state).toBe('idle')
    expect(controller.getStatus('right').state).toBe('ringing')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(controller.getStatus('right').state).toBe('idle')
  })

  it('cancels a persisted snooze even when the confirmation clear fails', async () => {
    await controller.start('right', { ...CONFIG, duration: 0 })
    await controller.snooze('right', 60)
    client.setAlarm.mockClear()
    client.clearAlarm.mockRejectedValueOnce(new Error('hardware unavailable'))

    await expect(controller.stop('right')).rejects.toThrow('hardware unavailable')

    expect(controller.getStatus('right').state).toBe('idle')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.setAlarm).not.toHaveBeenCalled()
  })

  it.each(['left', 'right'] satisfies Side[])('uses the side-specific hardware clear for stop on %s', async (side) => {
    await controller.stop(side)
    expect(client.clearAlarm).toHaveBeenCalledWith(side)
  })

  it('clamps delays to the signed 32-bit setTimeout ceiling', async () => {
    vi.setSystemTime(0)
    const maxSeconds = Math.floor((2 ** 31 - 1) / 1000)

    await controller.start('right', { ...CONFIG, duration: 0 })
    const status = await controller.snooze('right', Number.MAX_SAFE_INTEGER)

    expect(status?.snoozeUntil).toBe(maxSeconds)
    expect(controller.getStatus('right').snoozeUntil).toBe(maxSeconds)
    expect(vi.getTimerCount()).toBe(1)
  })
})
