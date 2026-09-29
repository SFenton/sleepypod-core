'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { Card, CardHeader } from '@/src/components/ds'
import { STREAM_GROUPS, fmtSeen, groupForType } from './streamGroups'

const RATE_WINDOW_MS = 60_000

interface StreamRow {
  perMin: number
  lastSeen: number | null
  lastType: string | null
}

/**
 * Streams table for the Pipeline tab: per stream group, frames received in
 * the trailing minute and time since the last frame. Frames are tracked in
 * refs and folded into state once a second.
 */
export function StreamsCard() {
  const windowRef = useRef<Array<{ group: string, ts: number }>>([])
  const lastRef = useRef<Record<string, { ts: number, type: string }>>({})
  const [rows, setRows] = useState<Record<string, StreamRow>>({})
  const [now, setNow] = useState(0)

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    const group = groupForType(frame.type)
    if (!group) return
    const ts = Date.now()
    windowRef.current.push({ group, ts })
    lastRef.current[group] = { ts, type: frame.type }
  }, []))

  useEffect(() => {
    const tick = () => {
      const t = Date.now()
      windowRef.current = windowRef.current.filter(e => e.ts >= t - RATE_WINDOW_MS)
      const next: Record<string, StreamRow> = {}
      for (const g of STREAM_GROUPS) {
        next[g.key] = {
          perMin: windowRef.current.filter(e => e.group === g.key).length,
          lastSeen: lastRef.current[g.key]?.ts ?? null,
          lastType: lastRef.current[g.key]?.type ?? null,
        }
      }
      setRows(next)
      setNow(t)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <Card>
      <CardHeader
        title="Streams"
        right={<span className="font-mono text-xs text-fg-2">frames/min · last seen</span>}
      />
      {STREAM_GROUPS.map((g) => {
        const row = rows[g.key]
        const seen = row?.lastSeen != null ? now - row.lastSeen : null
        return (
          <div key={g.key} className="flex items-center gap-3 border-t border-line pt-3" data-testid={`stream-${g.key}`}>
            <span className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
              <span className="block size-[7px] shrink-0 rounded-full" style={{ background: g.color }} />
              {g.label}
              <span className="truncate font-mono text-[11px] text-fg-2">{row?.lastType ?? g.types[0]}</span>
            </span>
            <span className="w-10 text-right font-mono text-[13px]">{row ? row.perMin : '—'}</span>
            <span className="w-10 text-right font-mono text-xs text-fg-2">{fmtSeen(seen)}</span>
          </div>
        )
      })}
    </Card>
  )
}
