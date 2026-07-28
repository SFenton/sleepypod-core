import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { GestureEvent } from '../dacMonitor'
import type { HardwareClient } from '../client'

const alarmMock = vi.hoisted(() => ({
  getAlarmStatus: vi.fn(() => ({ active: false, state: 'idle' })),
  snoozeAlarm: vi.fn(),
  stopAlarm: vi.fn(),
}))

vi.mock('../snoozeManager', () => alarmMock)

import { GestureActionHandler, type GestureActionDeps } from '../gestureActionHandler'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOCKET_PATH = '/tmp/test-gesture.sock'

const makeEvent = (
  side: 'left' | 'right',
  tapType: 'doubleTap' | 'tripleTap' | 'quadTap'
): GestureEvent => ({ side, tapType, timestamp: new Date() })

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
  gestureRow: object | null = null,
  stateRow: object | null = null,
  client: HardwareClient = makeMockClient()
): { deps: GestureActionDeps, client: HardwareClient, recordTemperatureChange: ReturnType<typeof vi.fn> } => {
  const recordTemperatureChange = vi.fn().mockResolvedValue(undefined)
  return {
    client,
    deps: {
      findGestureConfig: vi.fn().mockResolvedValue(gestureRow),
      findDeviceState: vi.fn().mockResolvedValue(stateRow),
      newHardwareClient: vi.fn().mockReturnValue(client),
      recordTemperatureChange,
    },
    recordTemperatureChange,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GestureActionHandler', () => {
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

  test('no-op when no gesture config row exists', async () => {
    const { deps, client } = makeDeps(null)
    const handler = new GestureActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'doubleTap'))

    expect((client.setTemperature as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((client.clearAlarm as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((client.setPower as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  describe('temperature action', () => {
    test('increments temperature', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
      const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
      const { deps, client, recordTemperatureChange } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('left', 75)
      expect(recordTemperatureChange).toHaveBeenCalledWith('left', 75)
      expect(vi.mocked(client.setTemperature).mock.invocationCallOrder[0]).toBeLessThan(
        recordTemperatureChange.mock.invocationCallOrder[0],
      )
    })

    test('decrements temperature', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 3 }
      const state = { targetTemperature: 80 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'tripleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('right', 77)
    })

    test('clamps to MIN_TEMP (55°F)', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 10 }
      const state = { targetTemperature: 57 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('left', 55)
    })

    test('clamps to MAX_TEMP (110°F)', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 10 }
      const state = { targetTemperature: 108 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('right', 110)
    })

    test('defaults to 75°F when no device state row', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 2 }
      const { deps, client } = makeDeps(gesture, null)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('left', 77)
    })
  })

  describe('power action', () => {
    test('toggles power and preserves cached target when powering on', async () => {
      const gesture = { actionType: 'power', powerBehavior: 'toggle' }
      const state = { targetTemperature: 72, isPowered: false, isAlarmVibrating: false }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).toHaveBeenCalledWith('left', true, 72)
    })
  })

  describe('alarm action — active alarm', () => {
    test('dismisses active alarm', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss' }
      const state = { isAlarmVibrating: true, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(alarmMock.stopAlarm).toHaveBeenCalledWith('left', { client })
      expect(client.clearAlarm).toHaveBeenCalledWith('left')
    })

    test('snoozes active alarm — clears immediately', async () => {
      vi.useFakeTimers()
      const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 300 }
      const state = { isAlarmVibrating: true, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'tripleTap'))

      expect(alarmMock.snoozeAlarm).toHaveBeenCalledWith('left', 300, {
        client,
        fallbackConfig: {
          vibrationIntensity: 50,
          vibrationPattern: 'rise',
          duration: 180,
        },
      })
      expect(client.clearAlarm).toHaveBeenCalledWith('left')
    })

    test('passes alarm restart ownership to the lifecycle controller', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 300 }
      const state = { isAlarmVibrating: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'tripleTap'))

      expect(alarmMock.snoozeAlarm).toHaveBeenCalledOnce()
      expect(client.setAlarm).not.toHaveBeenCalled()
    })

    test('stops a snoozed occurrence even though the DB vibrating flag is false', async () => {
      alarmMock.getAlarmStatus.mockReturnValue({ active: true, state: 'snoozed' })
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: 70 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(alarmMock.stopAlarm).toHaveBeenCalledWith('left', { client })
      expect(client.setPower).not.toHaveBeenCalled()
    })
  })

  describe('alarm action — inactive alarm', () => {
    test('toggles power on when pod is off (alarmInactiveBehavior=power) — preserves polled target', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: 70 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).toHaveBeenCalledWith('left', true, 70)
    })

    test('power-on falls back to TEMP_NEUTRAL when no targetTemperature is cached', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: null }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).toHaveBeenCalledWith('left', true, 82.5)
    })

    test('toggles power off when pod is on (alarmInactiveBehavior=power)', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: true, targetTemperature: 72 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))

      expect(client.setPower).toHaveBeenCalledWith('right', false, undefined)
    })

    test('no-op when alarmInactiveBehavior=none', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'none' }
      const state = { isAlarmVibrating: false, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).not.toHaveBeenCalled()
      expect(client.clearAlarm).not.toHaveBeenCalled()
    })
  })

  test('cleanup leaves snooze timer ownership with the lifecycle controller', async () => {
    const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 300 }
    const state = { isAlarmVibrating: true }
    const { deps } = makeDeps(gesture, state)

    const handler = new GestureActionHandler(SOCKET_PATH, deps)
    await handler.handle(makeEvent('left', 'tripleTap'))

    handler.cleanup()
    expect(alarmMock.snoozeAlarm).toHaveBeenCalledOnce()
  })

  test('lifecycle snooze failures are logged without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    alarmMock.snoozeAlarm.mockRejectedValueOnce(new Error('connect refused'))
    const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 60 }
    const state = { isAlarmVibrating: true }
    const { deps } = makeDeps(gesture, state)

    await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'tripleTap'))
    expect(errSpy).toHaveBeenCalledWith(
      'GestureActionHandler: error executing action for left tripleTap:',
      'connect refused',
    )
    errSpy.mockRestore()
  })

  test('errors in execution do not throw', async () => {
    const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
    const client = makeMockClient({
      setTemperature: vi.fn().mockRejectedValue(new Error('hardware failure')),
    })
    const { deps } = makeDeps(gesture, { targetTemperature: 70 }, client)

    await expect(
      new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))
    ).resolves.not.toThrow()
  })
})
