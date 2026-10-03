/**
 * TapGestureConfig — Pod 5 cover-button row descriptions for idle vs ringing,
 * and the editor save / remove payloads (button, step mode, power behavior).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const setMutate = vi.fn()
  const deleteMutate = vi.fn()
  const state = { gestures: { left: [] as unknown[], right: [] as unknown[] } }
  return {
    setMutate,
    deleteMutate,
    state,
    trpc: {
      useUtils: () => ({ settings: { getAll: { invalidate: vi.fn() } } }),
      settings: {
        getAll: { useQuery: () => ({ data: { gestures: state.gestures, sides: {} }, isLoading: false, error: null }) },
        setGesture: { useMutation: () => ({ mutate: setMutate, isPending: false, error: null }) },
        deleteGesture: { useMutation: () => ({ mutate: deleteMutate, isPending: false, error: null }) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { idleDescription, ringingDescription, TapGestureConfig } from '../TapGestureConfig'

const gesture = (overrides: Record<string, unknown>) => ({
  id: 1,
  side: 'left',
  button: 'top',
  tapType: 'doubleTap',
  actionType: 'temperature',
  temperatureChange: 'increment',
  temperatureAmount: 2,
  temperatureStepMode: 'degree',
  powerBehavior: null,
  alarmBehavior: null,
  alarmSnoozeDuration: null,
  alarmInactiveBehavior: null,
  ...overrides,
}) as Parameters<typeof idleDescription>[0]

beforeEach(() => {
  trpcMock.setMutate.mockClear()
  trpcMock.deleteMutate.mockClear()
  trpcMock.state.gestures = { left: [], right: [] }
})

describe('gesture descriptions', () => {
  it('describes unset gestures', () => {
    expect(idleDescription(undefined)).toBe('Not set')
    expect(ringingDescription(undefined)).toBe('Not set')
  })

  it('shows temperature changes the same in both contexts', () => {
    expect(idleDescription(gesture({}))).toBe('Temperature +2°')
    expect(ringingDescription(gesture({ temperatureChange: 'decrement', temperatureAmount: 1 }))).toBe('Temperature −1°')
  })

  it('describes level steps, defaulting legacy rows to levels', () => {
    expect(idleDescription(gesture({ temperatureStepMode: 'level', temperatureAmount: 1 }))).toBe('Temperature +1 level')
    expect(idleDescription(gesture({ temperatureStepMode: undefined, temperatureAmount: 3 }))).toBe('Temperature +3 levels')
  })

  it('describes power gestures in both contexts', () => {
    expect(idleDescription(gesture({ actionType: 'power', powerBehavior: 'toggle' }))).toBe('Power on / off')
    expect(ringingDescription(gesture({ actionType: 'power', powerBehavior: 'on' }))).toBe('Power on')
    expect(idleDescription(gesture({ actionType: 'power', powerBehavior: 'off' }))).toBe('Power off')
  })

  it('describes alarm gestures by context', () => {
    const snooze = gesture({ actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 420, alarmInactiveBehavior: 'power' })
    expect(ringingDescription(snooze)).toBe('Snooze 7 min')
    expect(idleDescription(snooze)).toBe('Power on / off')
    const dismiss = gesture({ actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'none' })
    expect(ringingDescription(dismiss)).toBe('Stop alarm')
    expect(idleDescription(dismiss)).toBe('Nothing')
  })
})

describe('TapGestureConfig', () => {
  it('shows only the plus and minus cover buttons', () => {
    render(<TapGestureConfig filterSide="left" />)
    expect(screen.getByText('Plus button')).toBeTruthy()
    expect(screen.getByText('Minus button')).toBeTruthy()
    expect(screen.queryByLabelText(/Triple tap/)).toBeNull()
  })

  it('saves a new plus-button gesture as one warmer level', () => {
    render(<TapGestureConfig filterSide="right" />)
    fireEvent.click(screen.getByLabelText('Plus button double tap: Not set'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'right',
      button: 'top',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
      temperatureStepMode: 'level',
    })
  })

  it('defaults the minus button to cooler and saves degree steps', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Minus button double tap: Not set'))
    fireEvent.click(screen.getByText('Degrees'))
    fireEvent.click(screen.getByLabelText('Increase Amount'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      button: 'bottom',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'decrement',
      temperatureAmount: 2,
      temperatureStepMode: 'degree',
    })
  })

  it('saves a power gesture', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Plus button double tap: Not set'))
    fireEvent.click(screen.getByText('Power'))
    fireEvent.click(screen.getByText('On'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      button: 'top',
      tapType: 'doubleTap',
      actionType: 'power',
      powerBehavior: 'on',
    })
  })

  it('saves an alarm gesture, omitting snooze duration when dismissing', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Minus button double tap while ringing: Not set'))
    fireEvent.click(screen.getByText('Alarm & power'))
    fireEvent.click(screen.getByText('Stop alarm'))
    fireEvent.click(screen.getByText('Power on / off'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      button: 'bottom',
      tapType: 'doubleTap',
      actionType: 'alarm',
      alarmBehavior: 'dismiss',
      alarmSnoozeDuration: undefined,
      alarmInactiveBehavior: 'power',
    })
  })

  it('removes an existing gesture for its button', () => {
    trpcMock.state.gestures = { left: [gesture({})], right: [] }
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Plus button double tap: Temperature +2°'))
    fireEvent.click(screen.getByText('Remove'))
    expect(trpcMock.deleteMutate).toHaveBeenCalledWith({ side: 'left', button: 'top', tapType: 'doubleTap' })
  })

  it('ignores gestures configured for other buttons', () => {
    trpcMock.state.gestures = { left: [gesture({ button: 'surface' })], right: [] }
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Plus button double tap: Not set'))
    expect(screen.queryByText('Remove')).toBeNull()
  })
})
