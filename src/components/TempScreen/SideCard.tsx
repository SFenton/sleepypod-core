'use client'

import { Minus, Plane, Plus, Power } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, IconButton, StatusDot } from '@/src/components/ds'
import { ACCENT_VAR, TempControl, directionFor } from '@/src/components/TempControl/TempControl'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { ControlVariant, TempDisplay } from '@/src/providers/PrefsProvider'
import type { Side } from '@/src/providers/SideProvider'
import type { TemperatureControlStatus } from '@/src/temperature/controller'
import { HoldDurationRow, HoldStatus } from './TemperatureHoldControls'

/** 'in' / 'out' when occupancy can be sensed; null = unknown (claim omitted). */
export type Presence = 'in' | 'out' | null

export interface SideCardProps {
  side: Side
  name: string
  presence: Presence
  away: boolean
  control: TemperatureControlStatus | undefined
  variant: ControlVariant
  display: TempDisplay
  unit: TempUnit
  targetF: number
  bedF: number | null
  isOn: boolean
  stepDisabled: boolean
  powerDisabled: boolean
  holdMinutes: number
  onHoldChange: (minutes: number) => void
  onPreview: (f: number) => void
  onCommit: (f: number) => void
  onStep: (delta: number) => void
  onPower: () => void
  onResumed: () => void
  /** Phones show one side at a time; the other card is hidden below 900px. */
  hiddenOnPhone?: boolean
}

function sideLine(side: Side, presence: Presence, away: boolean) {
  const parts = [side === 'left' ? 'Left' : 'Right']
  if (away) parts.push('Away')
  else if (presence) parts.push(presence === 'in' ? 'In bed' : 'Out of bed')
  return parts.join(' · ')
}

/**
 * One side of the bed: header, ownership line, dial/slider, −/power/+ and the
 * hold duration. Desktop (≥900px) shows the name header and 48px buttons;
 * phones fold the side line into the ownership row and use 52/60/52 buttons.
 */
export function SideCard({
  side,
  name,
  presence,
  away,
  control,
  variant,
  display,
  unit,
  targetF,
  bedF,
  isOn,
  stepDisabled,
  powerDisabled,
  holdMinutes,
  onHoldChange,
  onPreview,
  onCommit,
  onStep,
  onPower,
  onResumed,
  hiddenOnPhone,
}: SideCardProps) {
  const accent = ACCENT_VAR[directionFor(targetF, bedF)]
  const line = sideLine(side, presence, away)

  return (
    <Card
      role="group"
      aria-label={`${name} (${side})`}
      className={cn('gap-3.5 p-[18px] min-[900px]:p-5', hiddenOnPhone && 'max-[899px]:hidden')}
    >
      <div className="hidden items-center gap-2 min-[900px]:flex">
        <span className="truncate text-[15px] font-medium">{name}</span>
        {!away && presence && <StatusDot tone={presence === 'in' ? 'ok' : 'muted'} />}
        <span className="sp-label ml-auto flex shrink-0 items-center gap-1.5">
          {away && <Plane size={12} />}
          {line}
        </span>
      </div>

      <HoldStatus
        side={side}
        control={control}
        prefix={<span className="shrink-0 min-[900px]:hidden">{line}</span>}
        onResumed={onResumed}
      />

      <div className="flex justify-center min-[900px]:mt-3">
        <TempControl
          variant={variant}
          display={display}
          targetF={targetF}
          bedF={bedF}
          unit={unit}
          power={isOn}
          onChange={onPreview}
          onCommit={onCommit}
          statusOverride={isOn ? undefined : 'OFF'}
        />
      </div>

      <div className="flex items-center justify-center gap-5 min-[900px]:gap-4">
        <IconButton
          icon={Minus}
          size={52}
          label="Cooler"
          className="min-[900px]:!size-12"
          disabled={stepDisabled}
          onClick={() => onStep(-1)}
        />
        <IconButton
          icon={Power}
          size={60}
          label={isOn ? 'Turn off' : 'Turn on'}
          aria-pressed={isOn}
          accent={isOn ? accent : undefined}
          className="min-[900px]:!size-12"
          disabled={powerDisabled}
          onClick={onPower}
        />
        <IconButton
          icon={Plus}
          size={52}
          label="Warmer"
          className="min-[900px]:!size-12"
          disabled={stepDisabled}
          onClick={() => onStep(1)}
        />
      </div>

      <HoldDurationRow holdMinutes={holdMinutes} onDurationChange={onHoldChange} />
    </Card>
  )
}
