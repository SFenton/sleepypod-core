'use client'

import { useState, useCallback } from 'react'
import { Hand, Minus, Plus, Trash2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Button, Card, CardHeader, InlineError, Modal, SegmentedControl, SettingRow, Skeleton, Stepper, ValueChip } from '@/src/components/ds'
import { SectionColumns } from './SettingsLayout'

type TapType = 'singleTap' | 'doubleTap' | 'tripleTap' | 'quadTap'
type CoverButton = 'top' | 'middle' | 'bottom'
type GestureButton = 'surface' | CoverButton
type ActionType = 'temperature' | 'alarm' | 'power'
type Side = 'left' | 'right'
type TemperatureStepMode = 'degree' | 'level'
type PowerBehavior = 'toggle' | 'on' | 'off'

interface GestureRecord {
  id: number
  side: Side
  button: GestureButton
  tapType: TapType
  actionType: ActionType
  temperatureChange: 'increment' | 'decrement' | null
  temperatureAmount: number | null
  temperatureStepMode?: TemperatureStepMode | null
  powerBehavior?: PowerBehavior | null
  alarmBehavior: 'snooze' | 'dismiss' | null
  alarmSnoozeDuration: number | null
  alarmInactiveBehavior: 'power' | 'none' | null
}

/** Pod 5 cover buttons with configurable gestures. The middle (power) button is firmware-owned. */
const COVER_BUTTONS: { key: CoverButton, label: string, subtitle: string, icon: typeof Plus }[] = [
  { key: 'top', label: 'Plus button', subtitle: 'Top button on your side of the cover', icon: Plus },
  { key: 'bottom', label: 'Minus button', subtitle: 'Bottom button on your side of the cover', icon: Minus },
]

/** Cover-button gestures are double-tap only (migration 0018_focus_cover_button_double_taps). */
const TAP_TYPES: { key: TapType, label: string }[] = [
  { key: 'doubleTap', label: 'Double tap' },
]

function temperatureLabel(g: GestureRecord): string {
  const dir = g.temperatureChange === 'increment' ? '+' : '−'
  const amount = g.temperatureAmount ?? 1
  if ((g.temperatureStepMode ?? 'level') === 'level') {
    return `Temperature ${dir}${amount} level${amount === 1 ? '' : 's'}`
  }
  return `Temperature ${dir}${amount}°`
}

function powerLabel(g: GestureRecord): string {
  if (g.powerBehavior === 'on') return 'Power on'
  if (g.powerBehavior === 'off') return 'Power off'
  return 'Power on / off'
}

/** What the gesture does when no alarm is ringing. */
export function idleDescription(g: GestureRecord | undefined): string {
  if (!g) return 'Not set'
  if (g.actionType === 'temperature') return temperatureLabel(g)
  if (g.actionType === 'power') return powerLabel(g)
  return g.alarmInactiveBehavior === 'power' ? 'Power on / off' : 'Nothing'
}

/** What the gesture does while an alarm is ringing. */
export function ringingDescription(g: GestureRecord | undefined): string {
  if (!g) return 'Not set'
  if (g.actionType === 'temperature') return temperatureLabel(g)
  if (g.actionType === 'power') return powerLabel(g)
  if (g.alarmBehavior === 'snooze') return `Snooze ${Math.round((g.alarmSnoozeDuration ?? 300) / 60)} min`
  return 'Stop alarm'
}

interface EditState {
  side: Side
  button: CoverButton
  tapType: TapType
  actionType: ActionType
  temperatureChange: 'increment' | 'decrement'
  temperatureAmount: number
  temperatureStepMode: TemperatureStepMode
  powerBehavior: PowerBehavior
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
  temperatureStepMode: 'level',
  powerBehavior: 'toggle',
  alarmBehavior: 'snooze',
  alarmSnoozeDuration: 300,
  alarmInactiveBehavior: 'none',
})

function editStateFromGesture(g: GestureRecord, button: CoverButton): EditState {
  return {
    side: g.side,
    button,
    tapType: g.tapType,
    actionType: g.actionType,
    temperatureChange: g.temperatureChange ?? (button === 'bottom' ? 'decrement' : 'increment'),
    temperatureAmount: g.temperatureAmount ?? 1,
    temperatureStepMode: g.temperatureStepMode ?? 'level',
    powerBehavior: g.powerBehavior ?? 'toggle',
    alarmBehavior: g.alarmBehavior ?? 'snooze',
    alarmSnoozeDuration: g.alarmSnoozeDuration ?? 300,
    alarmInactiveBehavior: g.alarmInactiveBehavior ?? 'none',
  }
}

/**
 * Pod 5 cover-button gestures for one side: what double taps on the plus and
 * minus buttons do normally and while an alarm is ringing. Each chip opens
 * the gesture editor.
 */
export function TapGestureConfig({ filterSide = 'left' }: { filterSide?: Side } = {}) {
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
      setEditing(null)
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

  const openEditor = (button: CoverButton, tapType: TapType) => {
    const gesture = findGesture(filterSide, button, tapType)
    setEditing(gesture ? editStateFromGesture(gesture, button) : defaultEditState(filterSide, button, tapType))
  }

  const handleSave = useCallback(() => {
    if (!editing) return
    const target = { side: editing.side, button: editing.button, tapType: editing.tapType }

    if (editing.actionType === 'temperature') {
      setGesture.mutate({
        ...target,
        actionType: 'temperature',
        temperatureChange: editing.temperatureChange,
        temperatureAmount: editing.temperatureAmount,
        temperatureStepMode: editing.temperatureStepMode,
      })
    }
    else if (editing.actionType === 'power') {
      setGesture.mutate({
        ...target,
        actionType: 'power',
        powerBehavior: editing.powerBehavior,
      })
    }
    else {
      setGesture.mutate({
        ...target,
        actionType: 'alarm',
        alarmBehavior: editing.alarmBehavior,
        alarmSnoozeDuration:
          editing.alarmBehavior === 'snooze' ? editing.alarmSnoozeDuration : undefined,
        alarmInactiveBehavior: editing.alarmInactiveBehavior,
      })
    }
  }, [editing, setGesture])

  const handleDelete = useCallback(
    (side: Side, button: CoverButton, tapType: TapType) => {
      deleteGesture.mutate({ side, button, tapType })
    },
    [deleteGesture]
  )

  if (settingsQuery.isLoading) {
    return (
      <SectionColumns
        left={<Skeleton className="h-[148px]" />}
        right={<Skeleton className="h-[148px]" />}
      />
    )
  }

  const buttonCard = ({ key: button, label: buttonLabel, subtitle, icon }: typeof COVER_BUTTONS[number]) => (
    <Card>
      <CardHeader title={buttonLabel} subtitle={subtitle} icon={icon} iconClassName="text-icon" />
      {TAP_TYPES.flatMap(({ key, label }) => {
        const gesture = findGesture(filterSide, button, key)
        return [false, true].map((ringing) => {
          const description = ringing ? ringingDescription(gesture) : idleDescription(gesture)
          const rowLabel = ringing ? `${label} while ringing` : label
          return (
            <SettingRow key={`${key}-${ringing}`} label={rowLabel}>
              <ValueChip
                aria-label={`${buttonLabel} ${rowLabel.toLowerCase()}: ${description}`}
                onClick={() => openEditor(button, key)}
                className={gesture ? undefined : 'text-fg-2'}
              >
                {description}
              </ValueChip>
            </SettingRow>
          )
        })
      })}
    </Card>
  )

  const editingButton = editing ? COVER_BUTTONS.find(b => b.key === editing.button)?.label : ''
  const editingTap = editing ? TAP_TYPES.find(t => t.key === editing.tapType)?.label.toLowerCase() : ''
  const editingExists = editing ? !!findGesture(editing.side, editing.button, editing.tapType) : false

  return (
    <>
      <SectionColumns
        left={buttonCard(COVER_BUTTONS[0])}
        right={buttonCard(COVER_BUTTONS[1])}
      />
      {settingsQuery.error && <InlineError>{settingsQuery.error.message}</InlineError>}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${editingButton} ${editingTap} · ${sideName(editing.side)}` : ''}
        icon={Hand}
        iconClassName="text-icon"
        width={480}
        footer={editing && (
          <>
            {editingExists && (
              <Button
                variant="danger"
                icon={Trash2}
                onClick={() => handleDelete(editing.side, editing.button, editing.tapType)}
                disabled={deleteGesture.isPending}
              >
                Remove
              </Button>
            )}
            <div className="ml-auto flex gap-2.5">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleSave} disabled={setGesture.isPending}>
                {setGesture.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </>
        )}
      >
        {editing && (
          <GestureEditPanel state={editing} onChange={setEditing} />
        )}
        {setGesture.error && <InlineError>{setGesture.error.message}</InlineError>}
        {deleteGesture.error && <InlineError>{deleteGesture.error.message}</InlineError>}
      </Modal>
    </>
  )
}

/**
 * Body of the gesture editor: action type plus its parameters.
 */
function GestureEditPanel({
  state,
  onChange,
}: {
  state: EditState
  onChange: (s: EditState) => void
}) {
  const levels = state.temperatureStepMode === 'level'
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        full
        ariaLabel="Gesture action"
        value={state.actionType}
        options={[
          { value: 'temperature', label: 'Temperature' },
          { value: 'power', label: 'Power' },
          { value: 'alarm', label: 'Alarm & power' },
        ]}
        onChange={actionType => onChange({ ...state, actionType })}
      />

      {state.actionType === 'temperature' && (
        <>
          <SettingRow label="Direction">
            <SegmentedControl
              ariaLabel="Direction"
              value={state.temperatureChange}
              options={[{ value: 'increment', label: 'Warmer' }, { value: 'decrement', label: 'Cooler' }]}
              onChange={temperatureChange => onChange({ ...state, temperatureChange })}
            />
          </SettingRow>
          <SettingRow label="Step by" sub="Levels follow the Home Assistant −10 to 10 scale">
            <SegmentedControl
              ariaLabel="Step by"
              value={state.temperatureStepMode}
              options={[{ value: 'level', label: 'Levels' }, { value: 'degree', label: 'Degrees' }]}
              onChange={temperatureStepMode => onChange({ ...state, temperatureStepMode })}
            />
          </SettingRow>
          <SettingRow label="Amount">
            <Stepper
              label="Amount"
              value={state.temperatureAmount}
              min={1}
              max={10}
              format={v => (levels ? `${v} level${v === 1 ? '' : 's'}` : `${v}°`)}
              onChange={temperatureAmount => onChange({ ...state, temperatureAmount })}
            />
          </SettingRow>
        </>
      )}

      {state.actionType === 'power' && (
        <SettingRow label="Power">
          <SegmentedControl
            ariaLabel="Power behavior"
            value={state.powerBehavior}
            options={[
              { value: 'toggle', label: 'On / off' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={powerBehavior => onChange({ ...state, powerBehavior })}
          />
        </SettingRow>
      )}

      {state.actionType === 'alarm' && (
        <>
          <SettingRow label="While ringing">
            <SegmentedControl
              ariaLabel="While ringing"
              value={state.alarmBehavior}
              options={[{ value: 'snooze', label: 'Snooze' }, { value: 'dismiss', label: 'Stop alarm' }]}
              onChange={alarmBehavior => onChange({ ...state, alarmBehavior })}
            />
          </SettingRow>
          {state.alarmBehavior === 'snooze' && (
            <SettingRow label="Snooze for">
              <Stepper
                label="Snooze duration"
                value={Math.round(state.alarmSnoozeDuration / 60)}
                min={1}
                max={10}
                format={v => `${v} min`}
                onChange={mins => onChange({ ...state, alarmSnoozeDuration: mins * 60 })}
              />
            </SettingRow>
          )}
          <SettingRow label="When no alarm">
            <SegmentedControl
              ariaLabel="When no alarm"
              value={state.alarmInactiveBehavior}
              options={[{ value: 'none', label: 'Nothing' }, { value: 'power', label: 'Power on / off' }]}
              onChange={alarmInactiveBehavior => onChange({ ...state, alarmInactiveBehavior })}
            />
          </SettingRow>
        </>
      )}
    </div>
  )
}
