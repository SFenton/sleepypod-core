/**
 * Read-side singleton for the DAC: owns the transport connection, the polling
 * monitor, the gesture handler, and the device-state writer. **Does not** issue
 * commands itself — every writer goes through `getSharedHardwareClient()` from
 * `./sharedClient.ts`. Keeping the write surface out of this file makes it
 * obvious what the monitor's job is (observe + broadcast) and prevents new
 * accessors from accidentally landing here.
 *
 * Lifecycle (driven by `instrumentation.ts`):
 *   1. `startDacServer()`     — kicks off the DacTransport connection on dac.sock
 *   2. `getDacMonitor()`      — creates the monitor, gesture handler, state sync;
 *                               wires status / gesture events; starts polling
 *   3. `shutdownDacMonitor()` — stops the monitor, cancels snoozes, clears the
 *                               shared client, disconnects the transport
 *
 * Backed by `globalThis` so Turbopack module duplication can't produce two
 * monitors competing for the same socket.
 */

import { connectDac, disconnectDac } from './dacTransport'
import { DacMonitor } from './dacMonitor'
import { CoverButtonActionHandler, type CoverButton, type CoverButtonEvent } from './coverButtonActionHandler'
import { defaultCoverButtonActionDeps } from './coverButtonActionHandler.deps'
import { GestureActionHandler } from './gestureActionHandler'
import { defaultGestureActionDeps } from './gestureActionHandler.deps'
import { DeviceStateSync, getAlarmState } from './deviceStateSync'
import { trackPrimingState, resetPrimingState, getPrimeCompletedAt } from './primeNotification'
import { cancelSnooze, getSnoozeStatus } from './snoozeManager'
import { clearSharedHardwareClient, getSharedHardwareClient } from './sharedClient'
import type { Side } from './types'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock'

const KEYS = {
  server: '__sp_dac_server__',
  monitor: '__sp_dac_monitor__',
  gesture: '__sp_gesture_handler__',
  coverButton: '__sp_cover_button_handler__',
  unsubFlow: '__sp_unsub_flow__',
  unsubCoverButtons: '__sp_unsub_cover_buttons__',
} as const

const g = globalThis as Record<string, unknown>

const COVER_BUTTONS: readonly CoverButton[] = ['top', 'middle', 'bottom']
const COVER_BUTTON_ALIASES: Record<CoverButton, readonly string[]> = {
  top: ['top', 'plus', 'up', 'increase', 'increment', 'tempUp', 'temperatureUp'],
  middle: ['middle', 'center', 'centre', 'mid', 'power'],
  bottom: ['bottom', 'minus', 'down', 'decrease', 'decrement', 'tempDown', 'temperatureDown'],
}
const SIDE_ALIASES = {
  left: ['left', 'l'],
  right: ['right', 'r'],
} as const
const TAP_COUNT_BY_TYPE: Record<string, number> = {
  single: 1,
  singleTap: 1,
  double: 2,
  doubleTap: 2,
  triple: 3,
  tripleTap: 3,
  quad: 4,
  quadTap: 4,
  quadruple: 4,
  quadrupleTap: 4,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function readField(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    if (alias in record) return record[alias]
  }

  const normalizedAliases = aliases.map(normalizeKey)
  for (const [key, value] of Object.entries(record)) {
    if (normalizedAliases.includes(normalizeKey(key))) return value
  }

  return undefined
}

function normalizeSide(value: unknown): Side | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeKey(value)
  if (SIDE_ALIASES.left.some(alias => normalizeKey(alias) === normalized)) return 'left'
  if (SIDE_ALIASES.right.some(alias => normalizeKey(alias) === normalized)) return 'right'
  return null
}

function normalizeCoverButton(value: unknown): CoverButton | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeKey(value)
  for (const button of COVER_BUTTONS) {
    if (COVER_BUTTON_ALIASES[button].some(alias => normalizeKey(alias) === normalized)) return button
  }
  return null
}

function tapCountFromValue(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : null

  if (typeof value === 'number' || typeof value === 'string') {
    const count = Number(value)
    if (Number.isInteger(count) && count > 0 && count <= 4) return count

    if (typeof value === 'string') {
      const tapCount = TAP_COUNT_BY_TYPE[value]
      if (tapCount) return tapCount
    }
  }

  if (isRecord(value)) {
    return (
      tapCountFromValue(readField(value, ['count', 'tapCount', 'taps', 'tap', 'presses', 'clicks']))
      ?? tapCountFromValue(readField(value, ['tapType', 'type', 'gesture']))
    )
  }

  return null
}

function extractFlatCoverButtonEvent(frame: Record<string, unknown>): CoverButtonEvent | null {
  const side = normalizeSide(readField(frame, ['side', 'bedSide']))
  const button = normalizeCoverButton(readField(frame, ['button', 'coverButton', 'btn', 'key']))
  const count = tapCountFromValue(frame)
  if (!side || !button || !count) return null
  return { side, button, count, ts: typeof frame.ts === 'number' ? frame.ts : undefined }
}

function extractSidePayloadEvents(
  side: Side,
  payload: unknown,
  ts: number | undefined,
): CoverButtonEvent[] {
  if (!isRecord(payload)) return []

  const container = readField(payload, ['buttons', 'coverButtons', 'buttonEvent', 'buttonEvents'])
  const source = isRecord(container) ? container : payload
  const events: CoverButtonEvent[] = []

  for (const button of COVER_BUTTONS) {
    const count = tapCountFromValue(readField(source, COVER_BUTTON_ALIASES[button]))
    if (count) events.push({ side, button, count, ts })
  }

  return events
}

function extractCoverButtonEventList(value: unknown, fallbackTs: number | undefined): CoverButtonEvent[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => isRecord(item)
      ? extractFlatCoverButtonEvent({ ...item, ts: typeof item.ts === 'number' ? item.ts : fallbackTs })
      : null)
    .filter((event): event is CoverButtonEvent => Boolean(event))
}

function extractCoverButtonEvents(frame: Record<string, unknown>): CoverButtonEvent[] {
  const frameType = typeof frame.type === 'string' ? frame.type : ''
  const flatEvent = extractFlatCoverButtonEvent(frame)
  const listEvents = [
    ...extractCoverButtonEventList(readField(frame, ['events', 'buttonEvents']), typeof frame.ts === 'number' ? frame.ts : undefined),
    ...extractCoverButtonEventList(readField(frame, ['buttons', 'coverButtons']), typeof frame.ts === 'number' ? frame.ts : undefined),
  ]

  if (!/button|cover/i.test(frameType) && !flatEvent && listEvents.length === 0) return []

  const events: CoverButtonEvent[] = []
  const ts = typeof frame.ts === 'number' ? frame.ts : undefined
  for (const side of ['left', 'right'] as const) {
    const payload = readField(frame, SIDE_ALIASES[side])
    events.push(...extractSidePayloadEvents(side, payload, ts))
  }

  if (flatEvent) events.push(flatEvent)
  events.push(...listEvents)

  const seen = new Set<string>()
  return events.filter((event) => {
    const key = `${event.side}:${event.button}:${event.count}:${event.ts ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function startDacServer(): Promise<void> {
  if (g[KEYS.server]) return

  // connectDac blocks until frankenfirmware connects. Run it non-blocking
  // so the app can start in degraded mode if hardware isn't available yet.
  connectDac(DAC_SOCK_PATH).catch((error) => {
    console.warn('[DAC] connection failed (will retry on next command):', error instanceof Error ? error.message : error)
  })
  g[KEYS.server] = true
}

export function getDacServer(): unknown {
  return g[KEYS.server] ?? null
}

// Re-export for callers that historically imported from this module. The
// implementation lives in `./sharedClient.ts` — new code should import there.
export { getSharedHardwareClient }

const getCoverButtonActionHandler = (): CoverButtonActionHandler => {
  let handler = g[KEYS.coverButton] as CoverButtonActionHandler | undefined
  if (!handler) {
    handler = new CoverButtonActionHandler(DAC_SOCK_PATH, defaultCoverButtonActionDeps)
    g[KEYS.coverButton] = handler
  }
  return handler
}

export const dispatchCoverButtonEvent = async (event: CoverButtonEvent): Promise<void> => {
  await getCoverButtonActionHandler().handle(event)
}

let monitorInitPromise: Promise<DacMonitor> | null = null

export const getDacMonitor = async (): Promise<DacMonitor> => {
  if (g[KEYS.monitor]) return g[KEYS.monitor] as DacMonitor
  if (monitorInitPromise) return monitorInitPromise

  monitorInitPromise = (async () => {
    try {
      const hwClient = getSharedHardwareClient()
      const monitor = new DacMonitor({ socketPath: DAC_SOCK_PATH, hardwareClient: hwClient })
      const gestureHandler = new GestureActionHandler(DAC_SOCK_PATH, defaultGestureActionDeps)
      const coverButtonHandler = getCoverButtonActionHandler()
      const stateSync = new DeviceStateSync()

      monitor.on('gesture:detected', (event) => {
        gestureHandler.handle(event)
        // Broadcast to WS clients so browser UI can show gesture events
        // Dynamic import to avoid circular dependency (piezoStream is started separately)
        import('../streaming/piezoStream').then(({ broadcastFrame }) => {
          broadcastFrame({
            type: 'gesture',
            ts: Date.now(),
            side: event.side,
            tapType: event.tapType,
          })
        }).catch(() => { /* WS not ready */ })
      })
      monitor.on('status:updated', (status) => {
        try {
          trackPrimingState(status.isPriming)
        }
        catch (err) {
          console.error('[DacMonitor] primeNotification error:', err)
        }
        stateSync.sync(status).catch(err =>
          console.error('[DacMonitor] DeviceStateSync error:', err)
        )

        // Broadcast device status to WebSocket clients
        // Dynamic import to avoid circular dependency (piezoStream is started separately)
        import('../streaming/piezoStream').then(({ broadcastFrame }) => {
          const primeCompletedAt = getPrimeCompletedAt()
          const alarmState = getAlarmState()
          broadcastFrame({
            type: 'deviceStatus',
            ts: Date.now(),
            leftSide: { ...status.leftSide, isAlarmVibrating: alarmState.left },
            rightSide: { ...status.rightSide, isAlarmVibrating: alarmState.right },
            waterLevel: status.waterLevel,
            isPriming: status.isPriming,
            ...(primeCompletedAt && { primeCompletedNotification: { timestamp: primeCompletedAt } }),
            snooze: {
              left: getSnoozeStatus('left'),
              right: getSnoozeStatus('right'),
            },
          })
        }).catch(() => { /* WS server may not be started yet */ })
      })

      // Subscribe to sensor stream frames once, then fan out to the consumers
      // that need live server frames.
      import('../streaming/piezoStream').then(({ onServerFrame }) => {
        g[KEYS.unsubFlow] = onServerFrame((frame) => {
          stateSync.recordFlowData(frame as Record<string, unknown>)
        })
        g[KEYS.unsubCoverButtons] = onServerFrame((frame) => {
          for (const event of extractCoverButtonEvents(frame)) {
            void coverButtonHandler.handle(event)
          }
        })
      }).catch(() => { /* WS server may not be started yet */ })

      g[KEYS.monitor] = monitor
      g[KEYS.gesture] = gestureHandler
      g[KEYS.coverButton] = coverButtonHandler

      await monitor.start()
      console.log('[DAC] monitor started')

      return monitor
    }
    catch (error) {
      g[KEYS.monitor] = null
      g[KEYS.gesture] = null
      g[KEYS.coverButton] = null
      throw error
    }
    finally {
      monitorInitPromise = null
    }
  })()

  return monitorInitPromise
}

export const getDacMonitorIfRunning = (): DacMonitor | null =>
  (g[KEYS.monitor] as DacMonitor) ?? null

export const shutdownDacMonitor = async (): Promise<void> => {
  if (monitorInitPromise) {
    try {
      await monitorInitPromise
    }
    catch { /* ok */ }
  }

  const monitor = g[KEYS.monitor] as DacMonitor | undefined
  const gestureHandler = g[KEYS.gesture] as GestureActionHandler | undefined
  const coverButtonHandler = g[KEYS.coverButton] as CoverButtonActionHandler | undefined

  cancelSnooze('left')
  cancelSnooze('right')
  resetPrimingState()

  const unsubFlow = g[KEYS.unsubFlow] as (() => void) | undefined
  unsubFlow?.()
  const unsubCoverButtons = g[KEYS.unsubCoverButtons] as (() => void) | undefined
  unsubCoverButtons?.()

  g[KEYS.monitor] = null
  g[KEYS.gesture] = null
  g[KEYS.coverButton] = null
  g[KEYS.server] = null
  g[KEYS.unsubFlow] = null
  g[KEYS.unsubCoverButtons] = null
  clearSharedHardwareClient()
  monitorInitPromise = null

  gestureHandler?.cleanup()
  coverButtonHandler?.cleanup()

  if (monitor) {
    monitor.removeAllListeners('gesture:detected')
    monitor.removeAllListeners('status:updated')
    monitor.stop()
  }

  await disconnectDac()

  console.log('[DAC] shutdown complete')
}
