import type { HardwareClient } from './client'
import { MAX_TEMP, MIN_TEMP, TEMP_NEUTRAL, type Side } from './types'

export type CoverButton = 'top' | 'middle' | 'bottom'
export type CoverButtonTapType = 'singleTap' | 'doubleTap' | 'tripleTap' | 'quadTap'

export interface CoverButtonEvent {
  side: Side
  button: CoverButton
  count: number
  ts?: number
}

export interface CoverButtonActionRow {
  actionType: 'temperature' | 'alarm' | 'power'
  temperatureChange: 'increment' | 'decrement' | null
  temperatureAmount: number | null
  powerBehavior: 'toggle' | 'on' | 'off' | null
  alarmBehavior: 'snooze' | 'dismiss' | null
  alarmSnoozeDuration: number | null
  alarmInactiveBehavior: 'power' | 'none' | null
  feedbackVibrationEnabled: boolean
  feedbackVibrationIntensity: number | null
  feedbackVibrationPattern: 'double' | 'rise' | null
  feedbackVibrationDuration: number | null
}

export interface CoverButtonDeviceStateRow {
  targetTemperature: number | null
  isPowered: boolean
  isAlarmVibrating: boolean
}

export interface CoverButtonActionDeps {
  findActionConfig: (side: Side, button: CoverButton, tapType: CoverButtonTapType) => Promise<CoverButtonActionRow | null>
  findDeviceState: (side: Side) => Promise<CoverButtonDeviceStateRow | null>
  newHardwareClient: (socketPath: string) => HardwareClient
  triggerFeedbackHaptic: (side: Side) => Promise<void>
  recordTemperatureChange?: (side: Side, targetTemperature: number) => Promise<void>
}

const TAP_AGGREGATION_WINDOW_MS = 650

function tapTypeFromCount(count: number): CoverButtonTapType | null {
  if (count === 1) return 'singleTap'
  if (count === 2) return 'doubleTap'
  if (count === 3) return 'tripleTap'
  if (count === 4) return 'quadTap'
  return null
}

interface PendingCoverTap {
  count: number
  event: CoverButtonEvent
  timer: ReturnType<typeof setTimeout>
}

export class CoverButtonActionHandler {
  private readonly snoozeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set()
  private readonly pendingTaps = new Map<string, PendingCoverTap>()

  constructor(
    private readonly socketPath: string,
    private readonly deps: CoverButtonActionDeps,
  ) {}

  handle = async (event: CoverButtonEvent): Promise<void> => {
    if (event.count === 1) {
      await this.queueSingleTap(event)
      return
    }

    const key = this.pendingTapKey(event)
    const pending = this.pendingTaps.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingTaps.delete(key)
    }

    await this.handleResolvedTap(event, event.count)
  }

  private handleResolvedTap = async (event: CoverButtonEvent, count: number): Promise<void> => {
    const tapType = tapTypeFromCount(count)
    if (!tapType) return
    try {
      await this.executeSingle(event, tapType)
    }
    catch (error) {
      console.error(
        `CoverButtonActionHandler: error executing action for ${event.side} ${event.button} ${tapType}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  cleanup = (): void => {
    for (const pending of this.pendingTaps.values()) clearTimeout(pending.timer)
    this.pendingTaps.clear()
    for (const id of this.snoozeTimeouts) clearTimeout(id)
    this.snoozeTimeouts.clear()
  }

  private queueSingleTap = async (event: CoverButtonEvent): Promise<void> => {
    const key = this.pendingTapKey(event)
    const existing = this.pendingTaps.get(key)
    if (existing) clearTimeout(existing.timer)

    const count = Math.min(4, (existing?.count ?? 0) + 1)
    const pendingEvent = { ...event, count }

    if (count >= 4) {
      this.pendingTaps.delete(key)
      void this.handleResolvedTap(pendingEvent, count)
      return
    }

    const timer = setTimeout(() => {
      this.pendingTaps.delete(key)
      void this.handleResolvedTap(pendingEvent, count)
    }, TAP_AGGREGATION_WINDOW_MS)

    this.pendingTaps.set(key, { count, event: pendingEvent, timer })

    if (count > 1) {
      const immediateAction = await this.findImmediateAggregatedAction(pendingEvent, count)
      const current = this.pendingTaps.get(key)
      if (immediateAction && current?.event === pendingEvent) {
        clearTimeout(current.timer)
        this.pendingTaps.delete(key)
        await this.executeSingle(pendingEvent, immediateAction.tapType, immediateAction.action)
      }
    }
  }

  private pendingTapKey = (event: Pick<CoverButtonEvent, 'side' | 'button'>): string => {
    return `${event.side}:${event.button}`
  }

  private findImmediateAggregatedAction = async (
    event: CoverButtonEvent,
    count: number,
  ): Promise<{ tapType: CoverButtonTapType, action: CoverButtonActionRow } | null> => {
    const tapType = tapTypeFromCount(count)
    if (!tapType) return null

    const action = await this.deps.findActionConfig(event.side, event.button, tapType)
    if (!action) return null

    for (let higherCount = count + 1; higherCount <= 4; higherCount += 1) {
      const higherTapType = tapTypeFromCount(higherCount)
      if (!higherTapType) continue
      const higherAction = await this.deps.findActionConfig(event.side, event.button, higherTapType)
      if (higherAction) return null
    }

    return { tapType, action }
  }

  private executeSingle = async (
    event: CoverButtonEvent,
    tapType: CoverButtonTapType,
    resolvedAction?: CoverButtonActionRow,
  ): Promise<void> => {
    const action = resolvedAction ?? await this.deps.findActionConfig(event.side, event.button, tapType)
    if (!action) return

    if (action.actionType !== 'alarm') {
      await this.handleFeedbackVibration(event.side, action)
    }

    if (action.actionType === 'temperature') {
      await this.handleTemperatureAction(event.side, action)
    }
    else if (action.actionType === 'power') {
      await this.handlePowerAction(event.side, action)
    }
    else if (action.actionType === 'alarm') {
      await this.handleAlarmAction(event.side, action)
    }
  }

  private handleFeedbackVibration = async (
    side: Side,
    action: CoverButtonActionRow,
  ): Promise<void> => {
    if (!action.feedbackVibrationEnabled) return

    const state = await this.deps.findDeviceState(side)
    if (state?.isAlarmVibrating) return

    try {
      await this.deps.triggerFeedbackHaptic(side)
    }
    catch (error) {
      console.error(
        `CoverButtonActionHandler: feedback vibration failed for ${side}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  private handleTemperatureAction = async (
    side: Side,
    action: CoverButtonActionRow,
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(side)
    const currentTemp = state?.targetTemperature ?? 75
    const amount = action.temperatureAmount ?? 0
    if (!action.temperatureChange) return
    const delta = action.temperatureChange === 'increment' ? amount : -amount
    const newTemp = Math.min(MAX_TEMP, Math.max(MIN_TEMP, currentTemp + delta))

    const client = this.deps.newHardwareClient(this.socketPath)
    try {
      await client.connect()
      await client.setTemperature(side, newTemp)
      await this.deps.recordTemperatureChange?.(side, newTemp)
    }
    finally {
      client.disconnect()
    }
  }

  private handlePowerAction = async (
    side: Side,
    action: CoverButtonActionRow,
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(side)
    const behavior = action.powerBehavior ?? 'toggle'
    const nextPowered = behavior === 'toggle'
      ? !(state?.isPowered ?? false)
      : behavior === 'on'
    const target = state?.targetTemperature ?? TEMP_NEUTRAL

    const client = this.deps.newHardwareClient(this.socketPath)
    try {
      await client.connect()
      await client.setPower(side, nextPowered, nextPowered ? target : undefined)
    }
    finally {
      client.disconnect()
    }
  }

  private handleAlarmAction = async (
    side: Side,
    action: CoverButtonActionRow,
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(side)
    const isAlarmVibrating = state?.isAlarmVibrating ?? false

    if (!isAlarmVibrating) {
      if (action.alarmInactiveBehavior === 'power') {
        await this.handlePowerAction(side, { ...action, actionType: 'power', powerBehavior: 'toggle' })
      }
      return
    }

    const client = this.deps.newHardwareClient(this.socketPath)
    try {
      await client.connect()
      if (action.alarmBehavior === 'dismiss') {
        await client.clearAlarm(side)
        const { cancelSnooze } = await import('./snoozeManager')
        cancelSnooze(side)
      }
      else if (action.alarmBehavior === 'snooze') {
        await client.clearAlarm(side)
        const snoozeDuration = action.alarmSnoozeDuration ?? 300
        const timeoutId = setTimeout(() => {
          this.snoozeTimeouts.delete(timeoutId)
          const restartClient = this.deps.newHardwareClient(this.socketPath)
          restartClient.connect()
            .then(() => restartClient.setAlarm(side, {
              vibrationIntensity: 50,
              vibrationPattern: 'rise',
              duration: 180,
            }))
            .catch(err => console.error('CoverButtonActionHandler: snooze restart failed:', err))
            .finally(() => restartClient.disconnect())
        }, snoozeDuration * 1000)
        this.snoozeTimeouts.add(timeoutId)
      }
    }
    finally {
      client.disconnect()
    }
  }
}
