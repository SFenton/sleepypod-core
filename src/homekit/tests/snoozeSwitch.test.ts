import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

const mocks = vi.hoisted(() => ({
  snoozeAlarmFn: vi.fn().mockResolvedValue(null),
  stopAlarmFn: vi.fn().mockResolvedValue(undefined),
  state: { active: false },
}))

vi.mock('@/src/hardware/snoozeManager', () => ({
  snoozeAlarm: mocks.snoozeAlarmFn,
  stopAlarm: mocks.stopAlarmFn,
  getSnoozeStatus: () => ({ active: mocks.state.active, snoozeUntil: null }),
}))

const { snoozeAlarmFn: snoozeAlarm, stopAlarmFn: stopAlarm, state } = mocks

import { buildSnoozeSwitch } from '../accessories/snoozeSwitch'

describe('snoozeSwitch accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    snoozeAlarm.mockClear()
    stopAlarm.mockClear()
    state.active = false
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['left', 'right'] as const)('uses stable metadata for the %s side', (side) => {
    const { service, stop } = buildSnoozeSwitch(side)
    expect(service.displayName).toBe(`Snooze ${side}`)
    expect(service.subtype).toBe(`snooze-${side}`)
    stop()
  })

  it('on → requests one five-minute lifecycle snooze', async () => {
    const { service, stop } = buildSnoozeSwitch('left')
    await service.getCharacteristic(Characteristic.On).setValue(true)
    expect(snoozeAlarm).toHaveBeenCalledWith(
      'left',
      5 * 60,
      {
        fallbackConfig: expect.objectContaining({
          vibrationIntensity: 50,
          vibrationPattern: 'rise',
          duration: 60,
        }),
      },
    )
    stop()
  })

  it('off → stops the current occurrence', async () => {
    const { service, stop } = buildSnoozeSwitch('right')
    await service.getCharacteristic(Characteristic.On).setValue(false)
    expect(stopAlarm).toHaveBeenCalledWith('right')
    expect(snoozeAlarm).not.toHaveBeenCalled()
    stop()
  })

  it('leaves inactive snooze requests to the lifecycle controller', async () => {
    snoozeAlarm.mockResolvedValueOnce(null)
    const { service, stop } = buildSnoozeSwitch('left')
    await service.getCharacteristic(Characteristic.On).setValue(true)
    expect(snoozeAlarm).toHaveBeenCalledOnce()
    stop()
  })

  it('reports active per snoozeManager state', async () => {
    state.active = true
    const { service, stop } = buildSnoozeSwitch('left')
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(true)
    state.active = false
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false)
    stop()
  })

  it('publishes the latest snooze state on each poll', () => {
    const { service, stop } = buildSnoozeSwitch('left')
    const update = vi.spyOn(service, 'updateCharacteristic')
    state.active = true

    vi.advanceTimersByTime(5_000)

    expect(update).toHaveBeenCalledWith(Characteristic.On, true)
    stop()
  })

  it('does not require Node-specific unref support on the poll handle', () => {
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(7 as never)
    expect(() => buildSnoozeSwitch('left')).not.toThrow()
  })

  it('stop() clears the poll interval', () => {
    const { service, stop } = buildSnoozeSwitch('left')
    const update = vi.spyOn(service, 'updateCharacteristic')
    stop()
    state.active = true

    // Advance well past the poll interval — a stopped switch publishes nothing.
    vi.advanceTimersByTime(60_000)

    expect(update).not.toHaveBeenCalled()
  })
})
