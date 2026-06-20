'use client'

import { useState, useCallback } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Bell, ChevronDown, Hand, Minus, Plus, Power, Thermometer, Trash2 } from 'lucide-react'
import clsx from 'clsx'

type TapType = 'singleTap' | 'doubleTap' | 'tripleTap' | 'quadTap'
type CoverButton = 'top' | 'middle' | 'bottom'
type GestureButton = 'surface' | CoverButton
type ActionType = 'temperature' | 'alarm' | 'power'
type Side = 'left' | 'right'

interface ActionRecord {
  id: number
  side: Side
  actionType: ActionType
  temperatureChange: 'increment' | 'decrement' | null
  temperatureAmount: number | null
  powerBehavior?: 'toggle' | 'on' | 'off' | null
  alarmBehavior: 'snooze' | 'dismiss' | null
  alarmSnoozeDuration: number | null
  alarmInactiveBehavior: 'power' | 'none' | null
}

interface GestureRecord extends ActionRecord {
  button: GestureButton
  tapType: TapType
}

const COVER_BUTTON_TAP_TYPES: { key: TapType, label: string }[] = [
  { key: 'doubleTap', label: 'Double Tap' },
]

const COVER_BUTTONS: {
  key: CoverButton
  label: string
  description: string
  icon: typeof Plus
}[] = [
  { key: 'top', label: 'Plus Button', description: 'Top cover button', icon: Plus },
  { key: 'bottom', label: 'Minus Button', description: 'Bottom cover button', icon: Minus },
]

function actionDescription(action: ActionRecord): string {
  if (action.actionType === 'temperature') {
    const dir = action.temperatureChange === 'increment' ? '+' : '-'
    return `${dir}${action.temperatureAmount}° temp`
  }
  if (action.actionType === 'power') {
    if (action.powerBehavior === 'on') return 'Power on'
    if (action.powerBehavior === 'off') return 'Power off'
    return 'Toggle power'
  }
  return action.alarmBehavior === 'snooze' ? 'Snooze alarm' : 'Dismiss alarm'
}

interface EditState {
  side: Side
  button: CoverButton
  tapType: TapType
  actionType: ActionType
  temperatureChange: 'increment' | 'decrement'
  temperatureAmount: number
  powerBehavior: 'toggle' | 'on' | 'off'
  alarmBehavior: 'snooze' | 'dismiss'
  alarmSnoozeDuration: number
  alarmInactiveBehavior: 'power' | 'none'
}

const defaultEditState = (side: Side, button: CoverButton, tapType: TapType): EditState => ({
  side,
  button,
  tapType,
  actionType: 'temperature',
  temperatureChange: button === 'bottom' ? 'decrement' : 'increment',
  temperatureAmount: 1,
  powerBehavior: 'toggle',
  alarmBehavior: 'snooze',
  alarmSnoozeDuration: 300,
  alarmInactiveBehavior: 'none',
})

function editStateFromGesture(g: GestureRecord): EditState {
  return {
    side: g.side,
    button: g.button === 'surface' ? 'middle' : g.button,
    tapType: g.tapType,
    actionType: g.actionType,
    temperatureChange: g.temperatureChange ?? 'increment',
    temperatureAmount: g.temperatureAmount ?? 1,
    powerBehavior: g.powerBehavior ?? 'toggle',
    alarmBehavior: g.alarmBehavior ?? 'snooze',
    alarmSnoozeDuration: g.alarmSnoozeDuration ?? 300,
    alarmInactiveBehavior: g.alarmInactiveBehavior ?? 'none',
  }
}

function defaultGestureAction(side: Side, button: CoverButton, tapType: TapType): GestureRecord {
  const state = defaultEditState(side, button, tapType)
  return {
    id: -1,
    side,
    button,
    tapType,
    actionType: state.actionType,
    temperatureChange: state.actionType === 'temperature' ? state.temperatureChange : null,
    temperatureAmount: state.actionType === 'temperature' ? state.temperatureAmount : null,
    powerBehavior: state.actionType === 'power' ? state.powerBehavior : null,
    alarmBehavior: null,
    alarmSnoozeDuration: null,
    alarmInactiveBehavior: null,
  }
}

/**
 * Gesture configuration component.
 * Allows configuring double-tap actions for the physical top/bottom cover buttons.
 */
export function TapGestureConfig({ filterSide }: { filterSide?: 'left' | 'right' } = {}) {
  const { sideName } = useSideNames()
  const utils = trpc.useUtils()
  const settingsQuery = trpc.settings.getAll.useQuery({})
  const setGesture = trpc.settings.setGesture.useMutation({
    onSuccess: () => {
      utils.settings.getAll.invalidate()
      setEditing(null)
    },
  })
  const deleteGesture = trpc.settings.deleteGesture.useMutation({
    onSuccess: () => {
      utils.settings.getAll.invalidate()
    },
  })

  const [editing, setEditing] = useState<EditState | null>(null)

  const gestures = settingsQuery.data?.gestures as
    | { left: GestureRecord[], right: GestureRecord[] }
    | undefined

  const findGesture = useCallback(
    (side: Side, button: CoverButton, tapType: TapType): GestureRecord | undefined => {
      return gestures?.[side]?.find((g: GestureRecord) => g.button === button && g.tapType === tapType)
    },
    [gestures]
  )

  const handleSave = useCallback(() => {
    if (!editing) return

    if (editing.actionType === 'temperature') {
      setGesture.mutate({
        side: editing.side,
        button: editing.button,
        tapType: editing.tapType,
        actionType: 'temperature',
        temperatureChange: editing.temperatureChange,
        temperatureAmount: editing.temperatureAmount,
      })
      return
    }

    if (editing.actionType === 'power') {
      setGesture.mutate({
        side: editing.side,
        button: editing.button,
        tapType: editing.tapType,
        actionType: 'power',
        powerBehavior: editing.powerBehavior,
      })
      return
    }

    setGesture.mutate({
      side: editing.side,
      button: editing.button,
      tapType: editing.tapType,
      actionType: 'alarm',
      alarmBehavior: editing.alarmBehavior,
      alarmSnoozeDuration:
        editing.alarmBehavior === 'snooze' ? editing.alarmSnoozeDuration : undefined,
      alarmInactiveBehavior: editing.alarmInactiveBehavior,
    })
  }, [editing, setGesture])

  const handleDelete = useCallback(
    (side: Side, button: CoverButton, tapType: TapType) => {
      deleteGesture.mutate({ side, button, tapType })
    },
    [deleteGesture]
  )

  const renderGestureRows = (side: Side, button: CoverButton) => {
    const buttonMeta = COVER_BUTTONS.find(b => b.key === button)
    if (!buttonMeta) return null
    const Icon = buttonMeta.icon

    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 px-1 pt-1">
          <Icon size={12} className="text-zinc-600" />
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
            {buttonMeta.label}
          </p>
        </div>

        {COVER_BUTTON_TAP_TYPES.map(({ key, label }) => {
          const gesture = findGesture(side, button, key)
          const displayAction = gesture ?? defaultGestureAction(side, button, key)
          const isEditing
            = editing?.side === side && editing?.button === button && editing?.tapType === key

          return (
            <div key={`${side}-${button}-${key}`}>
              <div className="flex min-h-[44px] items-center gap-3 rounded-xl bg-zinc-900/50 px-3 py-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
                  <Hand size={14} className={gesture ? 'text-zinc-500' : 'text-zinc-700'} />
                </div>

                <div className="flex-1">
                  <span className="text-sm text-zinc-300">{label}</span>
                  <p className="text-xs text-zinc-500">
                    {gesture ? actionDescription(gesture) : `Unset · default ${actionDescription(displayAction)}`}
                  </p>
                </div>

                {gesture
                  ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() =>
                            setEditing(
                              isEditing ? null : editStateFromGesture(gesture)
                            )}
                          className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800 active:text-zinc-300"
                        >
                          <ChevronDown
                            size={14}
                            className={clsx(
                              'transition-transform',
                              isEditing && 'rotate-180'
                            )}
                          />
                        </button>
                        <button
                          onClick={() => handleDelete(side, button, key)}
                          disabled={deleteGesture.isPending}
                          className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-600 active:bg-zinc-800 active:text-red-400 disabled:opacity-50"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )
                  : (
                      <button
                        onClick={() =>
                          setEditing(
                            isEditing ? null : defaultEditState(side, button, key)
                          )}
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-600 active:bg-zinc-800 active:text-sky-400"
                      >
                        <Plus size={14} />
                      </button>
                    )}
              </div>

              {/* Edit panel */}
              {isEditing && editing && (
                <GestureEditPanel
                  state={editing}
                  onChange={setEditing}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                  isSaving={setGesture.isPending}
                  allowPower
                />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const renderSideSection = (side: Side) => {
    return (
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-sky-400">{sideName(side)}</h4>
        {COVER_BUTTONS.map(button => renderGestureRows(side, button.key))}
      </div>
    )
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-28 rounded bg-zinc-800" />
          <div className="h-10 rounded-xl bg-zinc-800" />
          <div className="h-10 rounded-xl bg-zinc-800" />
          <div className="h-10 rounded-xl bg-zinc-800" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-2xl bg-zinc-900 p-3 sm:space-y-4 sm:p-4">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-white">Gestures</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Assign double taps on the Pod 5 plus/minus cover buttons to
          temperature, power, or alarm actions.
        </p>
      </div>

      {/* Side sections — filtered if filterSide is set */}
      {(!filterSide || filterSide === 'left') && renderSideSection('left')}
      {!filterSide && <div className="border-t border-zinc-800" />}
      {(!filterSide || filterSide === 'right') && renderSideSection('right')}
    </div>
  )
}

/**
 * Inline edit panel for configuring a tap gesture action.
 */
function GestureEditPanel({
  state,
  onChange,
  onSave,
  onCancel,
  isSaving,
  allowPower,
}: {
  state: EditState
  onChange: (s: EditState) => void
  onSave: () => void
  onCancel: () => void
  isSaving: boolean
  allowPower: boolean
}) {
  return (
    <div className="mt-1 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
      {/* Action type selector */}
      <div className="flex rounded-lg bg-zinc-800 p-0.5">
        <button
          onClick={() => onChange({ ...state, actionType: 'temperature' })}
          className={clsx(
            'flex flex-1 min-h-[44px] items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
            state.actionType === 'temperature'
              ? 'bg-zinc-700 text-white'
              : 'text-zinc-500'
          )}
        >
          <Thermometer size={12} />
          Temperature
        </button>
        <button
          onClick={() => onChange({ ...state, actionType: 'alarm' })}
          className={clsx(
            'flex flex-1 min-h-[44px] items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
            state.actionType === 'alarm'
              ? 'bg-zinc-700 text-white'
              : 'text-zinc-500'
          )}
        >
          <Bell size={12} />
          Alarm
        </button>
        {allowPower && (
          <button
            onClick={() => onChange({ ...state, actionType: 'power' })}
            className={clsx(
              'flex flex-1 min-h-[44px] items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
              state.actionType === 'power'
                ? 'bg-zinc-700 text-white'
                : 'text-zinc-500'
            )}
          >
            <Power size={12} />
            Power
          </button>
        )}
      </div>

      {/* Temperature config */}
      {state.actionType === 'temperature' && (
        <div className="space-y-3">
          {/* Direction */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Direction</span>
            <div className="flex rounded-lg bg-zinc-800 p-0.5">
              <button
                onClick={() =>
                  onChange({ ...state, temperatureChange: 'increment' })}
                className={clsx(
                  'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium transition-colors',
                  state.temperatureChange === 'increment'
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-zinc-500'
                )}
              >
                + Up
              </button>
              <button
                onClick={() =>
                  onChange({ ...state, temperatureChange: 'decrement' })}
                className={clsx(
                  'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium transition-colors',
                  state.temperatureChange === 'decrement'
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-zinc-500'
                )}
              >
                - Down
              </button>
            </div>
          </div>

          {/* Amount */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Amount</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  onChange({
                    ...state,
                    temperatureAmount: Math.max(1, state.temperatureAmount - 1),
                  })}
                className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400 active:bg-zinc-700"
              >
                -
              </button>
              <span className="w-8 text-center text-sm font-medium text-white">
                {state.temperatureAmount}
                °
              </span>
              <button
                onClick={() =>
                  onChange({
                    ...state,
                    temperatureAmount: Math.min(10, state.temperatureAmount + 1),
                  })}
                className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400 active:bg-zinc-700"
              >
                +
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Power config */}
      {state.actionType === 'power' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Behavior</span>
            <div className="flex rounded-lg bg-zinc-800 p-0.5">
              {(['toggle', 'on', 'off'] as const).map(behavior => (
                <button
                  key={behavior}
                  onClick={() =>
                    onChange({ ...state, powerBehavior: behavior })}
                  className={clsx(
                    'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium capitalize transition-colors',
                    state.powerBehavior === behavior
                      ? 'bg-sky-500/20 text-sky-400'
                      : 'text-zinc-500'
                  )}
                >
                  {behavior}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Alarm config */}
      {state.actionType === 'alarm' && (
        <div className="space-y-3">
          {/* Behavior */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Behavior</span>
            <div className="flex rounded-lg bg-zinc-800 p-0.5">
              <button
                onClick={() =>
                  onChange({ ...state, alarmBehavior: 'snooze' })}
                className={clsx(
                  'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium transition-colors',
                  state.alarmBehavior === 'snooze'
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-zinc-500'
                )}
              >
                Snooze
              </button>
              <button
                onClick={() =>
                  onChange({ ...state, alarmBehavior: 'dismiss' })}
                className={clsx(
                  'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium transition-colors',
                  state.alarmBehavior === 'dismiss'
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-zinc-500'
                )}
              >
                Dismiss
              </button>
            </div>
          </div>

          {/* Snooze duration (only when snooze selected) */}
          {state.alarmBehavior === 'snooze' && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">Snooze Duration</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    onChange({
                      ...state,
                      alarmSnoozeDuration: Math.max(
                        60,
                        state.alarmSnoozeDuration - 60
                      ),
                    })}
                  className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400 active:bg-zinc-700"
                >
                  -
                </button>
                <span className="w-12 text-center text-sm font-medium text-white">
                  {Math.round(state.alarmSnoozeDuration / 60)}
                  m
                </span>
                <button
                  onClick={() =>
                    onChange({
                      ...state,
                      alarmSnoozeDuration: Math.min(
                        600,
                        state.alarmSnoozeDuration + 60
                      ),
                    })}
                  className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400 active:bg-zinc-700"
                >
                  +
                </button>
              </div>
            </div>
          )}

          {/* Inactive alarm behavior */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">When No Alarm</span>
            <div className="flex rounded-lg bg-zinc-800 p-0.5">
              <button
                onClick={() =>
                  onChange({ ...state, alarmInactiveBehavior: 'none' })}
                className={clsx(
                  'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium transition-colors',
                  state.alarmInactiveBehavior === 'none'
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-zinc-500'
                )}
              >
                Nothing
              </button>
              <button
                onClick={() =>
                  onChange({ ...state, alarmInactiveBehavior: 'power' })}
                className={clsx(
                  'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium transition-colors',
                  state.alarmInactiveBehavior === 'power'
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'text-zinc-500'
                )}
              >
                Power Off
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save/Cancel buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={onCancel}
          className="flex-1 rounded-xl bg-zinc-800 min-h-[44px] text-xs font-medium text-zinc-400 active:bg-zinc-700"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={isSaving}
          className="flex-1 rounded-xl bg-sky-500 min-h-[44px] text-xs font-medium text-white active:bg-sky-600 disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
