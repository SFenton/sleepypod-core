import { describe, expect, test, vi } from 'vitest'
import { createSensorHapticTrigger, encodeHapticConfirmFrame, HAPTIC_CONFIRM_DURATION_MS } from '../sensorHaptics'

describe('sensorHaptics', () => {
  test('encodes the hidden center-confirm haptic Sensor frame', () => {
    expect(encodeHapticConfirmFrame('left').toString('hex')).toBe('7e0540001907028481')
    expect(encodeHapticConfirmFrame('right').toString('hex')).toBe('7e054001190702f235')
  })

  test('queues same-side haptics until the firmware can accept another confirm pulse', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const writes: Array<{ at: number, frame: string, ttyPath: string }> = []
    const trigger = createSensorHapticTrigger({
      ttyPath: '/dev/test-sensor',
      writer: vi.fn(async (ttyPath, frame) => {
        writes.push({ at: Date.now(), frame: frame.toString('hex'), ttyPath })
      }),
    })

    const first = trigger('left')
    await Promise.resolve()
    await first
    expect(writes).toEqual([{ at: 0, frame: '7e0540001907028481', ttyPath: '/dev/test-sensor' }])

    await vi.advanceTimersByTimeAsync(250)
    const second = trigger('left')
    await Promise.resolve()
    expect(writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(HAPTIC_CONFIRM_DURATION_MS - 240)
    await second
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual({ at: 760, frame: '7e0540001907028481', ttyPath: '/dev/test-sensor' })

    vi.useRealTimers()
  })

  test('does not queue opposite-side haptics behind each other', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const writes: Array<{ at: number, frame: string }> = []
    const trigger = createSensorHapticTrigger({
      writer: vi.fn(async (_ttyPath, frame) => {
        writes.push({ at: Date.now(), frame: frame.toString('hex') })
      }),
    })

    await trigger('left')
    await vi.advanceTimersByTimeAsync(250)
    await trigger('right')

    expect(writes).toEqual([
      { at: 0, frame: '7e0540001907028481' },
      { at: 250, frame: '7e054001190702f235' },
    ])

    vi.useRealTimers()
  })
})
