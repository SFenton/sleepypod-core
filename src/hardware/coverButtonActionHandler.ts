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
}

function tapTypeFromCount(count: number): CoverButtonTapType | null {
  if (count === 1) return 'singleTap'
  if (count === 2) return 'doubleTap'
  if (count === 3) return 'tripleTap'
  if (count === 4) return 'quadTap'
  return null
}

export class CoverButtonActionHandler {
  private readonly snoozeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set()

  constructor(
    private readonly socketPath: string,
    private readonly deps: CoverButtonActionDeps,
  ) {}

  handle = async (event: CoverButtonEvent): Promise<void> => {
    const tapType = tapTypeFromCount(event.count)
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
    for (const id of this.snoozeTimeouts) clearTimeout(id)
    this.snoozeTimeouts.clear()
  }

  private executeSingle = async (event: CoverButtonEvent, tapType: CoverButtonTapType): Promise<void> => {
    const action = await this.deps.findActionConfig(event.side, event.button, tapType)
    if (!action) return

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
