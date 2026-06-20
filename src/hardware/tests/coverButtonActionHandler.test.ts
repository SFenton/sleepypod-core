import { afterEach, describe, expect, test, vi } from 'vitest'
import { CoverButtonActionHandler, type CoverButtonActionDeps, type CoverButtonEvent } from '../coverButtonActionHandler'
import type { HardwareClient } from '../client'

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
): { deps: CoverButtonActionDeps, client: HardwareClient } => ({
  client,
  deps: {
    findActionConfig: vi.fn().mockResolvedValue(actionRow),
    findDeviceState: vi.fn().mockResolvedValue(stateRow),
    newHardwareClient: vi.fn().mockReturnValue(client),
  },
})

describe('CoverButtonActionHandler', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  test('no-op when no cover-button config row exists', async () => {
    const { deps, client } = makeDeps(null)
    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'top'))

    expect(client.setTemperature).not.toHaveBeenCalled()
    expect(client.setPower).not.toHaveBeenCalled()
    expect(client.clearAlarm).not.toHaveBeenCalled()
  })

  test('executes temperature action once per count', async () => {
    const action = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1 }
    const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
    const { deps, client } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'top', 2))

    expect(client.setTemperature).toHaveBeenNthCalledWith(1, 'left', 71)
    expect(client.setTemperature).toHaveBeenNthCalledWith(2, 'left', 71)
  })

  test('decrements and clamps temperature', async () => {
    const action = { actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 10 }
    const state = { targetTemperature: 57, isPowered: true, isAlarmVibrating: false }
    const { deps, client } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'bottom'))

    expect(client.setTemperature).toHaveBeenCalledWith('right', 55)
  })

  test('toggles power and preserves cached target when powering on', async () => {
    const action = { actionType: 'power', powerBehavior: 'toggle' }
    const state = { targetTemperature: 72, isPowered: false, isAlarmVibrating: false }
    const { deps, client } = makeDeps(action, state)

    await new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'middle'))

    expect(client.setPower).toHaveBeenCalledWith('left', true, 72)
  })

  test('snoozes active alarms and cleanup cancels restart', async () => {
    vi.useFakeTimers()
    const restartClient = makeMockClient()
    const action = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 60 }
    const state = { isAlarmVibrating: true, isPowered: true }
    const newHardwareClient = vi.fn()
      .mockReturnValueOnce(makeMockClient())
      .mockReturnValueOnce(restartClient)
    const deps: CoverButtonActionDeps = {
      findActionConfig: vi.fn().mockResolvedValue(action),
      findDeviceState: vi.fn().mockResolvedValue(state),
      newHardwareClient,
    }

    const handler = new CoverButtonActionHandler(SOCKET_PATH, deps)
    await handler.handle(makeEvent('right', 'middle'))
    handler.cleanup()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(restartClient.setAlarm).not.toHaveBeenCalled()
  })

  test('errors in execution do not throw', async () => {
    const action = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1 }
    const client = makeMockClient({
      setTemperature: vi.fn().mockRejectedValue(new Error('hardware failure')),
    })
    const { deps } = makeDeps(action, { targetTemperature: 70 }, client)

    await expect(
      new CoverButtonActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'top')),
    ).resolves.not.toThrow()
  })
})
