import { EventEmitter } from 'node:events'

export type MqttStateChangeReason = 'device' | 'settings' | 'schedules' | 'button-action'

const events = new EventEmitter()

export function notifyMqttStateChanged(reason: MqttStateChangeReason): void {
  events.emit('state:changed', reason)
}

export function onMqttStateChanged(listener: (reason: MqttStateChangeReason) => void): () => void {
  events.on('state:changed', listener)
  return () => events.off('state:changed', listener)
}
