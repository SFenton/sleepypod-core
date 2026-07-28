/**
 * HomeKit Switch that snoozes (on) or cancels snooze (off) a side's alarm.
 * Snooze duration mirrors the iOS default (9 minutes) at neutral pattern.
 */

import { Service, Characteristic } from 'hap-nodejs'
import {
  getSnoozeStatus,
  snoozeAlarm,
  stopAlarm,
} from '@/src/hardware/snoozeManager'
import type { Side } from '@/src/hardware/types'

const SNOOZE_SECONDS = 5 * 60
const POLL_MS = 5_000

export interface SnoozeSwitchAccessory {
  service: Service
  stop: () => void
}

export function buildSnoozeSwitch(side: Side): SnoozeSwitchAccessory {
  const service = new Service.Switch(`Snooze ${side}`, `snooze-${side}`)

  const setOn = (on: boolean): void => {
    service.updateCharacteristic(Characteristic.On, on)
  }

  service.getCharacteristic(Characteristic.On)
    .onGet(() => getSnoozeStatus(side).active)
    .onSet(async (value) => {
      const on = Number(value) === 1
      if (on) {
        await snoozeAlarm(side, SNOOZE_SECONDS, {
          fallbackConfig: {
            vibrationIntensity: 50,
            vibrationPattern: 'rise',
            duration: 60,
          },
        })
      }
      else {
        await stopAlarm(side)
      }
    })

  const handle = setInterval(() => {
    setOn(getSnoozeStatus(side).active)
  }, POLL_MS)
  handle.unref?.()

  return {
    service,
    stop: () => clearInterval(handle),
  }
}
