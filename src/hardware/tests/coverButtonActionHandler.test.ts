import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { HardwareClient } from '../client'

const alarmMock = vi.hoisted(() => ({
  getAlarmStatus: vi.fn(() => ({ active: false, state: 'idle' })),
  snoozeAlarm: vi.fn(),
  stopAlarm: vi.fn(),
}))

vi.mock('../snoozeManager', () => alarmMock)

import { CoverButtonActionHandler, type CoverButtonActionDeps, type CoverButtonEvent } from '../coverButtonActionHandler'

const SOCKET_PATH = '/tmp/test-cover-button.sock'

const makeEvent = (
  side: 'left' | 'right',
  button: 'top' | 'middle' | 'bottom',
  count = 1,
): CoverButtonEvent => ({ side, button, count, ts: 123 })

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const makeMockClient = (overrides: DeepPartial<HardwareClient> = {}): HardwareClient => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  setTemperature: vi.fn().mockResolvedValue(undefined),
  clearAlarm: vi.fn().mockResolvedValue(undefined),
  setPower: vi.fn().mockResolvedValue(undefined),
  setAlarm: vi.fn().mockResolvedValue(undefined),
  ...overrides,
} as unknown as HardwareClient)

const makeDeps = (
  actionRow: object | null = null,
  stateRow: object | null = null,
  client: HardwareClient = makeMockClient(),
): {
  deps: CoverButtonActionDeps
  client: HardwareClient
  triggerFeedbackHaptic: ReturnType<typeof vi.fn>
  recordTemperatureChange: ReturnType<typeof vi.fn>
} => {
  const triggerFeedbackHaptic = vi.fn().mockResolvedValue(undefined)
  const recordTemperatureChange = vi.fn().mockResolvedValue(undefined)
  return {
    client,
    deps: {
      findActionConfig: vi.fn().mockResolvedValue(actionRow),
      findDeviceState: vi.fn().mockResolvedValue(stateRow),
      newHardwareClient: vi.fn().mockReturnValue(client),
      triggerFeedbackHaptic,
      recordTemperatureChange,
    },
    triggerFeedbackHaptic,
    recordTemperatureChange,
  }
}

describe('CoverButtonActionHandler', () => {
  beforeEach(() => {
    alarmMock.getAlarmStatus.mockReset().mockReturnValue({ active: false, state: 'idle' })
    alarmMock.snoozeAlarm.mockReset().mockImplementation(async (side, _duration, options) => {
      await options.client.clearAlarm(side)
      return { active: true, state: 'snoozed' }
    })
    alarmMock.stopAlarm.mockReset().mockImplementation(async (side, options) => {
      await options.client.clearAlarm(side)
      return { active: false, state: 'idle' }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  test('no-op when no cover-button config row exists', async () => {
    const { deps, client } = makeDeps(null)
    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'top', 2))

    expect(client.setTemperature).not.toHaveBeenCalled()
    expect(client.setPower).not.toHaveBeenCalled()
    expect(client.clearAlarm).not.toHaveBeenCalled()
  })

  test('executes the gesture matching the button tap count', async () => {
    const action = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1 }
    const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
    const { deps, client, recordTemperatureChange } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'top', 2))

    expect(deps.findActionConfig).toHaveBeenCalledWith('left', 'top', 'doubleTap')
    expect(client.setTemperature).toHaveBeenCalledTimes(1)
    expect(client.setTemperature).toHaveBeenCalledWith('left', 71)
    expect(recordTemperatureChange).toHaveBeenCalledWith('left', 71)
    expect(vi.mocked(client.setTemperature).mock.invocationCallOrder[0]).toBeLessThan(
      recordTemperatureChange.mock.invocationCallOrder[0],
    )
  })

  test('increments temperature by HA target level when level step mode is enabled', async () => {
    const action = {
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
      temperatureStepMode: 'level',
    }
    const state = { targetTemperature: 74, isPowered: true, isAlarmVibrating: false }
    const { deps, client, recordTemperatureChange } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'top', 2))

    expect(client.setTemperature).toHaveBeenCalledWith('left', 77)
    expect(recordTemperatureChange).toHaveBeenCalledWith('left', 77)
  })

  test('decrements temperature by HA target level when level step mode is enabled', async () => {
    const action = {
      actionType: 'temperature',
      temperatureChange: 'decrement',
      temperatureAmount: 1,
      temperatureStepMode: 'level',
    }
    const state = { targetTemperature: 77, isPowered: true, isAlarmVibrating: false }
    const { deps, client } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'bottom', 2))

    expect(client.setTemperature).toHaveBeenCalledWith('left', 74)
  })

  test('ignores unsupported button tap counts', async () => {
    const { deps, client } = makeDeps({ actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1 })

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'top', 5))

    expect(deps.findActionConfig).not.toHaveBeenCalled()
    expect(client.setTemperature).not.toHaveBeenCalled()
  })

  test('decrements and clamps temperature', async () => {
    const action = { actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 10 }
    const state = { targetTemperature: 57, isPowered: true, isAlarmVibrating: false }
    const { deps, client } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'bottom', 2))

    expect(client.setTemperature).toHaveBeenCalledWith('right', 55)
  })

  test('toggles power and preserves cached target when powering on', async () => {
    const action = { actionType: 'power', powerBehavior: 'toggle' }
    const state = { targetTemperature: 72, isPowered: false, isAlarmVibrating: false }
    const { deps, client } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'middle', 2))

    expect(client.setPower).toHaveBeenCalledWith('left', true, 72)
  })

  test('runs configured feedback vibration before a temperature action', async () => {
    vi.useFakeTimers()
    const action = {
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
      feedbackVibrationEnabled: true,
      feedbackVibrationIntensity: 40,
      feedbackVibrationPattern: 'double',
      feedbackVibrationDuration: 2,
    }
    const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
    const { client, deps, triggerFeedbackHaptic } = makeDeps(action, state)
    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'top', 2))

    expect(client.setTemperature).toHaveBeenCalledWith('left', 71)
    expect(triggerFeedbackHaptic).toHaveBeenCalledWith('left')
    expect(client.setAlarm).not.toHaveBeenCalled()
    expect(client.clearAlarm).not.toHaveBeenCalled()
    expect(triggerFeedbackHaptic.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.setTemperature).mock.invocationCallOrder[0],
    )

    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.clearAlarm).not.toHaveBeenCalled()
    handler.cleanup()
  })

  test('queues repeated feedback through the haptic trigger without clearing alarms', async () => {
    vi.useFakeTimers()
    const action = {
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
      feedbackVibrationEnabled: true,
      feedbackVibrationIntensity: 40,
      feedbackVibrationPattern: 'double',
      feedbackVibrationDuration: 2,
    }
    const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
    const { client, deps, triggerFeedbackHaptic } = makeDeps(action, state)
    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'top', 2))
    await vi.advanceTimersByTimeAsync(500)
    await handler.handle(makeEvent('left', 'bottom', 2))

    expect(triggerFeedbackHaptic).toHaveBeenCalledTimes(2)
    expect(client.setAlarm).not.toHaveBeenCalled()
    expect(client.clearAlarm).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.clearAlarm).not.toHaveBeenCalled()
    handler.cleanup()
  })

  test('skips feedback vibration while an alarm is already vibrating', async () => {
    const action = {
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
      feedbackVibrationEnabled: true,
      feedbackVibrationIntensity: 40,
      feedbackVibrationPattern: 'double',
      feedbackVibrationDuration: 2,
    }
    const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: true }
    const { client, deps } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'top', 2))

    expect(client.setTemperature).toHaveBeenCalledWith('left', 71)
    expect(client.setAlarm).not.toHaveBeenCalled()
  })

  test('routes active alarm snooze through the shared lifecycle controller', async () => {
    const action = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 60 }
    const state = { isAlarmVibrating: true, isPowered: true }
    const { deps, client } = makeDeps(action, state)

    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)
    await handler.handle(makeEvent('right', 'middle', 2))
    handler.cleanup()

    expect(alarmMock.snoozeAlarm).toHaveBeenCalledWith('right', 60, {
      client,
      fallbackConfig: {
        vibrationIntensity: 50,
        vibrationPattern: 'rise',
        duration: 180,
      },
    })
    expect(client.clearAlarm).toHaveBeenCalledWith('right')
    expect(client.setAlarm).not.toHaveBeenCalled()
  })

  test('stops a snoozed occurrence instead of running the inactive power action', async () => {
    alarmMock.getAlarmStatus.mockReturnValue({ active: true, state: 'snoozed' })
    const action = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
    const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: 70 }
    const { deps, client } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'middle', 2))

    expect(alarmMock.stopAlarm).toHaveBeenCalledWith('right', { client })
    expect(client.setPower).not.toHaveBeenCalled()
  })

  test('errors in execution do not throw', async () => {
    const action = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1 }
    const client = makeMockClient({
      setTemperature: vi.fn().mockRejectedValue(new Error('hardware failure')),
    })
    const { deps } = makeDeps(action, { targetTemperature: 70 }, client)

    await expect(
      new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'top', 2)),
    ).resolves.not.toThrow()
  })

  test('aggregates firmware single-click records into a double tap immediately when no higher action is configured', async () => {
    vi.useFakeTimers()
    const action = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1 }
    const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
    const client = makeMockClient()
    const deps: CoverButtonActionDeps = {
      findActionConfig: vi.fn().mockImplementation((_side, _button, tapType) => (
        Promise.resolve(tapType === 'doubleTap' ? action : null)
      )),
      findDeviceState: vi.fn().mockResolvedValue(state),
      newHardwareClient: vi.fn().mockReturnValue(client),
      triggerFeedbackHaptic: vi.fn().mockResolvedValue(undefined),
    }
    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'top', 1))
    await vi.advanceTimersByTimeAsync(300)
    await handler.handle(makeEvent('left', 'top', 1))

    expect(deps.findActionConfig).toHaveBeenCalledWith('left', 'top', 'doubleTap')
    expect(client.setTemperature).toHaveBeenCalledWith('left', 71)
  })

  test('waits to disambiguate double taps when a higher tap action exists', async () => {
    vi.useFakeTimers()
    const action = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1 }
    const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
    const client = makeMockClient()
    const deps: CoverButtonActionDeps = {
      findActionConfig: vi.fn().mockImplementation((_side, _button, tapType) => (
        Promise.resolve(tapType === 'doubleTap' || tapType === 'tripleTap' ? action : null)
      )),
      findDeviceState: vi.fn().mockResolvedValue(state),
      newHardwareClient: vi.fn().mockReturnValue(client),
      triggerFeedbackHaptic: vi.fn().mockResolvedValue(undefined),
    }
    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'top', 1))
    await vi.advanceTimersByTimeAsync(300)
    await handler.handle(makeEvent('left', 'top', 1))

    expect(client.setTemperature).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(650)

    expect(client.setTemperature).toHaveBeenCalledWith('left', 71)
  })
})
