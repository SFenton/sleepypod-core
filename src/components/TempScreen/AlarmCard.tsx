'use client'

import { Bell } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Card, InlineError, Skeleton, Toggle } from '@/src/components/ds'
import { formatTime12h } from '@/src/lib/scheduleTime'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { pickAlarmGroup, summarizeDays } from './tempScreenUtils'
import { useNow } from './TonightCard'

/**
 * Next alarm for the side with an on/off toggle. Alarms sharing a time are one
 * group ("Weekdays · 10s buzz"); the toggle flips every day in the group.
 *
 * Wires into schedules.getAll (alarm rows) and schedules.updateAlarmSchedule.
 */
export function AlarmCard({ side }: { side: Side }) {
  const utils = trpc.useUtils()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })
  const update = trpc.schedules.updateAlarmSchedule.useMutation()
  const now = useNow(60_000)
  // Keep the toggled group on screen after it turns off (otherwise the card
  // would jump to the next enabled alarm).
  const [pinnedTime, setPinnedTime] = useState<string | null>(null)
  const [pendingOn, setPendingOn] = useState<boolean | null>(null)

  if (isLoading) return <Skeleton className="h-[70px]" />

  const group = pickAlarmGroup(data?.alarm ?? [], now, pinnedTime)
  const on = pendingOn ?? group?.enabled ?? false

  const handleToggle = async (next: boolean) => {
    if (!group) return
    setPinnedTime(group.time)
    setPendingOn(next)
    const rows = next ? group.rows : group.rows.filter(r => r.enabled)
    try {
      await Promise.all(rows.map(r => update.mutateAsync({ id: r.id, enabled: next })))
    }
    catch {
      // update.error renders below; the refetch restores server truth.
    }
    finally {
      await utils.schedules.getAll.invalidate()
      setPendingOn(null)
    }
  }

  return (
    <Card className="flex-row items-center gap-2.5 py-3.5">
      <Bell size={16} className={cn('shrink-0', group && on ? 'text-warn' : 'text-fg-3')} />
      <div className="flex min-w-0 flex-col">
        {error
          ? <InlineError>{`Could not load alarms: ${error.message}`}</InlineError>
          : group
            ? (
                <>
                  <span className="font-mono text-sm">{formatTime12h(group.time)}</span>
                  <span className="truncate text-xs text-fg-2">
                    {`${summarizeDays(group.days)} · ${group.duration}s buzz`}
                  </span>
                </>
              )
            : <span className="text-sm text-fg-2">No alarm set</span>}
        {update.error && <InlineError>{`Could not update alarm: ${update.error.message}`}</InlineError>}
      </div>
      {group && (
        <Toggle
          className="ml-auto"
          on={on}
          label="Alarm enabled"
          disabled={update.isPending}
          onChange={next => void handleToggle(next)}
        />
      )}
    </Card>
  )
}
