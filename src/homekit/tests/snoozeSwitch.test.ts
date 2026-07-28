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

  it('stop() clears the poll interval', () => {
    const { stop } = buildSnoozeSwitch('left')
    stop()
    // Advance well past the poll interval — no errors / no leaked timers.
    vi.advanceTimersByTime(60_000)
  })
})
