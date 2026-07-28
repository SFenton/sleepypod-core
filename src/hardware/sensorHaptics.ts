import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Side } from './types'

const SENSOR_TTY_PATH = process.env.SENSOR_TTY_PATH || '/dev/ttyS2'
const FRAME_START = 0x7E
const CRC_START = 0x1D0F
const CRC_POLY_CCITT = 0x1021

const HAPTIC_OPCODE = 0x40
const HAPTIC_POWER = 25
const HAPTIC_PATTERN = 7
const HAPTIC_PULSE_COUNT = 2
export const HAPTIC_CONFIRM_DURATION_MS = 750
const HAPTIC_RETRIGGER_GAP_MS = HAPTIC_CONFIRM_DURATION_MS + 10

export type SensorHapticWriter = (ttyPath: string, frame: Buffer) => Promise<void>

export interface SensorHapticTriggerOptions {
  ttyPath?: string
  writer?: SensorHapticWriter
}

function sideByte(side: Side): number {
  return side === 'left' ? 0 : 1
}

function crcCcitt(payload: Uint8Array): number {
  let crc = CRC_START
  for (const byte of payload) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000)
        ? ((crc << 1) ^ CRC_POLY_CCITT) & 0xFFFF
        : (crc << 1) & 0xFFFF
    }
  }
  return crc
}

export function encodeSensorFrame(payload: Uint8Array): Buffer {
  if (payload.length > 0xFF) {
    throw new Error(`Sensor payload too long: ${payload.length}`)
  }

  const crc = crcCcitt(payload)
  return Buffer.from([
    FRAME_START,
    payload.length,
    ...payload,
    (crc >> 8) & 0xFF,
    crc & 0xFF,
  ])
}

export function encodeHapticConfirmFrame(side: Side): Buffer {
  return encodeSensorFrame(Buffer.from([
    HAPTIC_OPCODE,
    sideByte(side),
    HAPTIC_POWER,
    HAPTIC_PATTERN,
    HAPTIC_PULSE_COUNT,
  ]))
}

async function writeSensorFrame(ttyPath: string, frame: Buffer): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK
  const handle = await open(ttyPath, flags)
  try {
    await handle.write(frame, 0, frame.length)
  }
  finally {
    await handle.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createSensorHapticTrigger(
  options: SensorHapticTriggerOptions = {},
): (side: Side) => Promise<void> {
  const ttyPath = options.ttyPath ?? SENSOR_TTY_PATH
  const writer = options.writer ?? writeSensorFrame
  const nextAvailableAt = new Map<Side, number>()
  const queues = new Map<Side, Promise<void>>()

  return async (side: Side): Promise<void> => {
    const now = Date.now()
    const readyAt = Math.max(nextAvailableAt.get(side) ?? 0, now)
    const waitMs = Math.max(0, readyAt - now)
    nextAvailableAt.set(side, readyAt + HAPTIC_RETRIGGER_GAP_MS)

    const previous = queues.get(side) ?? Promise.resolve()
    const task = previous.then(async () => {
      if (waitMs > 0) await delay(waitMs)
      await writer(ttyPath, encodeHapticConfirmFrame(side))
    })

    const queueEntry: Promise<void> = task
      .catch(() => undefined)
      .then(() => {
        if (queues.get(side) === queueEntry) queues.delete(side)
      })
    queues.set(side, queueEntry)

    return task
  }
}

export const triggerHapticConfirm = createSensorHapticTrigger()
