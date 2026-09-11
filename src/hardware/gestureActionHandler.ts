import type { HardwareClient } from './client'
import { MAX_TEMP, MIN_TEMP, TEMP_NEUTRAL, type Side } from './types'
import type { GestureEvent } from './dacMonitor'
import { getAutomationEngineIfRunning } from '@/src/automation'
import { shouldBlock as pumpStallShouldBlock } from './pumpStallGuard'
import { withSideLock } from '@/src/hardware/sideLock'
import { getAlarmStatus, snoozeAlarm, stopAlarm } from './snoozeManager'

// Re-export for callers that need to build deps
export type { GestureActionDeps }

// These types mirror the DB row shapes without importing from @/src/db
export interface TapGestureRow {
  actionType: 'temperature' | 'alarm' | 'power'
  temperatureChange: 'increment' | 'decrement' | null
  temperatureAmount: number | null
  powerBehavior: 'toggle' | 'on' | 'off' | null
  alarmBehavior: 'snooze' | 'dismiss' | null
  /** Duration in seconds before a snoozed alarm restarts. */
  alarmSnoozeDuration: number | null
  /** Action when the alarm is not currently vibrating. `'power'` toggles pod power; `'none'` is a no-op. */
  alarmInactiveBehavior: 'power' | 'none' | null
}

export interface DeviceStateRow {
  targetTemperature: number | null
  isPowered: boolean
  isAlarmVibrating: boolean
}

interface GestureActionDeps {
  findGestureConfig: (side: Side, tapType: GestureEvent['tapType']) => Promise<TapGestureRow | null>
  findDeviceState: (side: Side) => Promise<DeviceStateRow | null>
  newHardwareClient: (socketPath: string) => HardwareClient
  recordTemperatureChange?: (side: Side, targetTemperature: number) => Promise<void>
}

/**
 * Consumes gesture:detected events and executes the configured hardware action.
 * Uses per-operation HardwareClient (same pattern as tRPC routers).
 * Errors in action execution are caught and logged — never propagate.
 *
 * Note on isAlarmVibrating: the hardware DEVICE_STATUS response does not
 * include alarm vibration state. The value is sourced from device_state DB
 * which is set externally (e.g., by the alarm scheduler) before/after alarms.
 * If device_state is stale the alarm action will fall through to the
 * alarmInactiveBehavior path.
 *
 * Pass `deps` to override DB/hardware behaviour in tests (dependency injection).
 */
export class GestureActionHandler {
  private readonly deps: GestureActionDeps

  constructor(
    private readonly socketPath: string,
    deps: GestureActionDeps
  ) {
    this.deps = deps
  }

  handle = async (event: GestureEvent): Promise<void> => {
    try {
      await this.execute(event)
    }
    catch (error) {
      console.error(
        `GestureActionHandler: error executing action for ${event.side} ${event.tapType}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  cleanup = (): void => {}

  private execute = async (event: GestureEvent): Promise<void> => {
    const gesture = await this.deps.findGestureConfig(event.side, event.tapType)
    if (!gesture) return

    if (gesture.actionType === 'temperature') {
      await this.handleTemperatureAction(event, gesture)
    }
    else if (gesture.actionType === 'power') {
      await this.handlePowerAction(event, gesture)
    }
    else if (gesture.actionType === 'alarm') {
      await this.handleAlarmAction(event, gesture)
    }
  }

  private handleTemperatureAction = async (
    event: GestureEvent,
    gesture: TapGestureRow
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(event.side)
    const currentTemp = state?.targetTemperature ?? 75
    const amount = gesture.temperatureAmount ?? 0
    if (!gesture.temperatureChange) return // misconfigured row — skip
    const delta = gesture.temperatureChange === 'increment' ? amount : -amount
    const newTemp = Math.min(MAX_TEMP, Math.max(MIN_TEMP, currentTemp + delta))

    await withSideLock(event.side, async () => {
      if (pumpStallShouldBlock(event.side)) {
        console.warn(`[gestureActionHandler] skipped setTemperature: pump stall guard blocks ${event.side}`)
        return
      }
      const client = this.deps.newHardwareClient(this.socketPath)
      try {
        getAutomationEngineIfRunning()?.registerManualOverride(event.side)
        await client.connect()
        await client.setTemperature(event.side, newTemp)
        await this.deps.recordTemperatureChange?.(event.side, newTemp)
      }
      finally {
        client.disconnect()
      }
    })
  }

  private handleAlarmAction = async (
    event: GestureEvent,
    gesture: TapGestureRow
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(event.side)
    const alarmActive = getAlarmStatus(event.side).active || (state?.isAlarmVibrating ?? false)

    if (alarmActive) {
      const client = this.deps.newHardwareClient(this.socketPath)
      try {
        await client.connect()

        if (gesture.alarmBehavior === 'dismiss') {
          await stopAlarm(event.side, { client })
        }
        else if (gesture.alarmBehavior === 'snooze') {
          await snoozeAlarm(event.side, gesture.alarmSnoozeDuration ?? 300, {
            client,
            fallbackConfig: {
              vibrationIntensity: 50,
              vibrationPattern: 'rise',
              duration: 180,
            },
          })
        }
      }
      finally {
        client.disconnect()
      }
    }
    else {
      if (gesture.alarmInactiveBehavior === 'power') {
        const currentlyPowered = state?.isPowered ?? false
        const nextPowered = !currentlyPowered
        // Pass the polled target so a power-on preserves the user's setpoint
        // across off-cycles instead of landing on the firmware-default
        // fallback in DacHardwareClient.setPower.
        const target = state?.targetTemperature ?? TEMP_NEUTRAL
        await withSideLock(event.side, async () => {
          if (nextPowered && pumpStallShouldBlock(event.side)) {
            console.warn(`[gestureActionHandler] skipped power-on: pump stall guard blocks ${event.side}`)
            return
          }
          const client = this.deps.newHardwareClient(this.socketPath)
          try {
            getAutomationEngineIfRunning()?.registerManualOverride(event.side)
            await client.connect()
            await client.setPower(event.side, nextPowered, nextPowered ? target : undefined)
          }
          finally {
            client.disconnect()
          }
        })
      }
      // alarmInactiveBehavior === 'none': no-op
    }
  }

  private handlePowerAction = async (
    event: GestureEvent,
    gesture: TapGestureRow
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(event.side)
    const behavior = gesture.powerBehavior ?? 'toggle'
    const nextPowered = behavior === 'toggle'
      ? !(state?.isPowered ?? false)
      : behavior === 'on'
    const target = state?.targetTemperature ?? TEMP_NEUTRAL

    const client = this.deps.newHardwareClient(this.socketPath)
    try {
      await client.connect()
      await client.setPower(event.side, nextPowered, nextPowered ? target : undefined)
    }
    finally {
      client.disconnect()
    }
  }
}
