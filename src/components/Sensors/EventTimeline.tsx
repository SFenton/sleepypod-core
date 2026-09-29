'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { Card, CardHeader } from '@/src/components/ds'
import { STREAM_GROUPS, groupForType } from './streamGroups'

const WINDOW_MS = 60_000
const MAX_EVENTS = 1200
const REDRAW_MS = 500

interface EventTick {
  group: string
  ts: number
}

/**
 * Live event timeline — the cadence of every WS frame type over the last
 * 60 seconds, one lane per stream (STS, PZO, CAP, TMP, FRZ, LOG). Reveals the
 * pod's rhythm: 2s device status, ~1 Hz piezo, ~2 Hz capSense, etc.
 */
export function EventTimeline() {
  const eventsRef = useRef<EventTick[]>([])
  const [snapshot, setSnapshot] = useState<{ now: number, events: EventTick[] }>({ now: 0, events: [] })

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    const group = groupForType(frame.type)
    if (!group) return
    eventsRef.current.push({ group, ts: Date.now() })
    if (eventsRef.current.length > MAX_EVENTS) {
      eventsRef.current = eventsRef.current.slice(-MAX_EVENTS)
    }
  }, []))

  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      eventsRef.current = eventsRef.current.filter(e => e.ts >= now - WINDOW_MS)
      setSnapshot({ now, events: eventsRef.current.slice() })
    }
    tick()
    const interval = setInterval(tick, REDRAW_MS)
    return () => clearInterval(interval)
  }, [])

  const start = snapshot.now - WINDOW_MS

  return (
    <Card>
      <CardHeader title="Event timeline" right={<span className="font-mono text-xs text-fg-2">last 60 s</span>} />
      <div className="flex flex-col gap-2">
        {STREAM_GROUPS.map(g => (
          <div key={g.key} className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2.5">
            <span className="font-mono text-[10px] text-fg-2">{g.lane}</span>
            <div className="relative h-4 border-b border-grid" data-testid={`lane-${g.lane}`}>
              {snapshot.events.filter(e => e.group === g.key).map((e, i) => (
                <span
                  key={`${e.ts}-${i}`}
                  className="absolute inset-y-0.5 w-0.5 rounded-[1px]"
                  style={{ left: `${Math.min(99.7, ((e.ts - start) / WINDOW_MS) * 100)}%`, background: g.color }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-2.5">
          <span />
          <div className="flex justify-between font-mono text-[10px] text-fg-3">
            <span>−60s</span>
            <span>−30s</span>
            <span>now</span>
          </div>
        </div>
      </div>
    </Card>
  )
}
