import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import {
  alarmSchedules,
  deviceSettings,
  powerSchedules,
  sideSettings,
  temperatureSchedules,
} from '@/src/db/schema'
import { getJobManager } from '@/src/scheduler'

export type Side = 'left' | 'right'
export type DayOfWeek = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'
export type ScheduleStage = 'bedtime' | 'asleep' | 'dawn'
export type ScheduleSummaryKey = 'nextPowerOn' | 'nextPowerOff' | 'nextAlarm' | 'nextTemperatureAdjustment'

export const SCHEDULE_DAYS: readonly DayOfWeek[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

export const SCHEDULE_STAGE_KEYS: readonly ScheduleStage[] = ['bedtime', 'asleep', 'dawn']
export const SCHEDULE_SUMMARY_KEYS: readonly ScheduleSummaryKey[] = [
  'nextPowerOn',
  'nextPowerOff',
  'nextAlarm',
  'nextTemperatureAdjustment',
]

const DAY_INDEX: Record<DayOfWeek, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

const MINUTES_PER_DAY = 24 * 60
const DEFAULT_BEDTIME = '22:00'
const DEFAULT_WAKE_TIME = '08:00'
const DEFAULT_BEDTIME_TEMPERATURE = 75

type PowerRow = typeof powerSchedules.$inferSelect
type TemperatureRow = typeof temperatureSchedules.$inferSelect
type AlarmRow = typeof alarmSchedules.$inferSelect

export interface ScheduleEvent {
  type: 'power_on' | 'power_off' | 'alarm' | 'temperature'
  side: Side
  scheduleDay: DayOfWeek
  executionDay: DayOfWeek
  time: string
  timestamp: string
  scheduleId: number
  temperatureF?: number
  enabled: boolean
}

export type SideScheduleSummary = Record<ScheduleSummaryKey, ScheduleEvent | null>

export interface SideMqttScheduleState {
  side: Side
  awayMode: boolean
  alarmsEnabled: boolean
  bedtime: string | null
  stageTemperatures: Record<ScheduleStage, number | null>
  summary: SideScheduleSummary
}

export interface MqttScheduleState {
  timezone: string
  currentLedBrightness: number
  ledDayBrightness: number
  ledNightBrightness: number
  sides: Record<Side, SideMqttScheduleState>
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function minutesToTime(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const hours = Math.floor(normalized / 60)
  const remaining = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

function dayFromIndex(index: number): DayOfWeek {
  return SCHEDULE_DAYS[((index % 7) + 7) % 7]
}

function localDateParts(now: Date, timezone: string): { year: number, month: number, day: number, weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now)
  const get = (type: string) => {
    const part = parts.find(p => p.type === type)
    if (!part) throw new Error(`Invalid timezone: ${timezone}`)
    return part.value
  }
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdays[get('weekday')] ?? 0,
  }
}

function timezoneOffsetMs(utcMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => {
    const part = parts.find(p => p.type === type)
    if (!part) throw new Error(`Invalid timezone: ${timezone}`)
    return Number(part.value)
  }
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - utcMs
}

function zonedWallTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  return guess - timezoneOffsetMs(guess, timezone)
}

function nextOccurrence(timezone: string, scheduleDay: DayOfWeek, time: string, dayOffset = 0, now = new Date()): Date {
  const local = localDateParts(now, timezone)
  const [hour, minute] = time.split(':').map(Number)
  const targetWeekday = (DAY_INDEX[scheduleDay] + dayOffset) % 7
  let daysUntilTarget = (targetWeekday - local.weekday + 7) % 7
  let candidateDate = new Date(Date.UTC(local.year, local.month - 1, local.day))
  candidateDate.setUTCDate(candidateDate.getUTCDate() + daysUntilTarget)
  let epoch = zonedWallTimeToEpochMs(
    candidateDate.getUTCFullYear(),
    candidateDate.getUTCMonth() + 1,
    candidateDate.getUTCDate(),
    hour,
    minute,
    timezone,
  )
  if (epoch <= now.getTime()) {
    daysUntilTarget += 7
    candidateDate = new Date(Date.UTC(local.year, local.month - 1, local.day))
    candidateDate.setUTCDate(candidateDate.getUTCDate() + daysUntilTarget)
    epoch = zonedWallTimeToEpochMs(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
      hour,
      minute,
      timezone,
    )
  }
  return new Date(epoch)
}

function earlier(current: ScheduleEvent | null, candidate: ScheduleEvent): ScheduleEvent {
  return !current || candidate.timestamp < current.timestamp ? candidate : current
}

function emptySummary(): SideScheduleSummary {
  return {
    nextPowerOn: null,
    nextPowerOff: null,
    nextAlarm: null,
    nextTemperatureAdjustment: null,
  }
}

function summarizeSide(
  side: Side,
  timezone: string,
  awayMode: boolean,
  powers: PowerRow[],
  temps: TemperatureRow[],
  alarms: AlarmRow[],
): SideScheduleSummary {
  const summary = emptySummary()
  if (awayMode) return summary

  for (const row of powers.filter(r => r.enabled)) {
    const powerOffNextDay = timeToMinutes(row.offTime) <= timeToMinutes(row.onTime)
    summary.nextPowerOn = earlier(summary.nextPowerOn, {
      type: 'power_on',
      side,
      scheduleDay: row.dayOfWeek,
      executionDay: row.dayOfWeek,
      time: row.onTime,
      timestamp: nextOccurrence(timezone, row.dayOfWeek, row.onTime).toISOString(),
      scheduleId: row.id,
      temperatureF: row.onTemperature,
      enabled: row.enabled,
    })
    summary.nextPowerOff = earlier(summary.nextPowerOff, {
      type: 'power_off',
      side,
      scheduleDay: row.dayOfWeek,
      executionDay: powerOffNextDay ? dayFromIndex(DAY_INDEX[row.dayOfWeek] + 1) : row.dayOfWeek,
      time: row.offTime,
      timestamp: nextOccurrence(timezone, row.dayOfWeek, row.offTime, powerOffNextDay ? 1 : 0).toISOString(),
      scheduleId: row.id,
      enabled: row.enabled,
    })
  }

  for (const row of alarms.filter(r => r.enabled)) {
    summary.nextAlarm = earlier(summary.nextAlarm, {
      type: 'alarm',
      side,
      scheduleDay: row.dayOfWeek,
      executionDay: row.dayOfWeek,
      time: row.time,
      timestamp: nextOccurrence(timezone, row.dayOfWeek, row.time).toISOString(),
      scheduleId: row.id,
      temperatureF: row.alarmTemperature,
      enabled: row.enabled,
    })
  }

  for (const row of temps.filter(r => r.enabled)) {
    summary.nextTemperatureAdjustment = earlier(summary.nextTemperatureAdjustment, {
      type: 'temperature',
      side,
      scheduleDay: row.dayOfWeek,
      executionDay: row.dayOfWeek,
      time: row.time,
      timestamp: nextOccurrence(timezone, row.dayOfWeek, row.time).toISOString(),
      scheduleId: row.id,
      temperatureF: row.temperature,
      enabled: row.enabled,
    })
  }

  return summary
}

function firstPowerByDay(rows: PowerRow[]): Map<DayOfWeek, PowerRow> {
  const map = new Map<DayOfWeek, PowerRow>()
  for (const day of SCHEDULE_DAYS) {
    const [row] = rows
      .filter(r => r.dayOfWeek === day)
      .sort((a, b) => a.id - b.id)
    if (row) map.set(day, row)
  }
  return map
}

function consistent<T>(values: T[]): T | null {
  if (values.length !== SCHEDULE_DAYS.length) return null
  const [first] = values
  return values.every(value => value === first) ? first : null
}

function relativeTemperatureEntries(day: DayOfWeek, powers: Map<DayOfWeek, PowerRow>, temps: TemperatureRow[]): TemperatureRow[] {
  const powerOn = powers.get(day)?.onTime ?? DEFAULT_BEDTIME
  const powerOnMinutes = timeToMinutes(powerOn)
  return temps
    .filter(t => t.dayOfWeek === day)
    .sort((a, b) => {
      const adjustedA = (timeToMinutes(a.time) - powerOnMinutes + MINUTES_PER_DAY) % MINUTES_PER_DAY
      const adjustedB = (timeToMinutes(b.time) - powerOnMinutes + MINUTES_PER_DAY) % MINUTES_PER_DAY
      return adjustedA - adjustedB
    })
}

function stageValue(day: DayOfWeek, stage: ScheduleStage, powers: Map<DayOfWeek, PowerRow>, temps: TemperatureRow[]): number | null {
  if (stage === 'bedtime') return powers.get(day)?.onTemperature ?? null
  const entries = relativeTemperatureEntries(day, powers, temps)
  if (stage === 'asleep') return entries[0]?.temperature ?? null
  return entries.length > 1 ? entries[entries.length - 1]?.temperature ?? null : null
}

function buildStageTemperatures(powers: PowerRow[], temps: TemperatureRow[]): Record<ScheduleStage, number | null> {
  const byDay = firstPowerByDay(powers)
  return {
    bedtime: consistent(SCHEDULE_DAYS.map(day => stageValue(day, 'bedtime', byDay, temps))),
    asleep: consistent(SCHEDULE_DAYS.map(day => stageValue(day, 'asleep', byDay, temps))),
    dawn: consistent(SCHEDULE_DAYS.map(day => stageValue(day, 'dawn', byDay, temps))),
  }
}

function buildBedtime(powers: PowerRow[]): string | null {
  const byDay = firstPowerByDay(powers)
  return consistent(SCHEDULE_DAYS.map(day => byDay.get(day)?.onTime ?? null))
}

function computeCurrentLedBrightness(
  timezone: string,
  nightModeEnabled: boolean,
  nightStart: string | null,
  nightEnd: string | null,
  dayBrightness: number,
  nightBrightness: number,
): number {
  if (!nightModeEnabled || !nightStart || !nightEnd) return dayBrightness
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date())
  const get = (type: string) => {
    const part = parts.find(p => p.type === type)
    if (!part) throw new Error(`Invalid timezone: ${timezone}`)
    return Number(part.value)
  }
  const hour = get('hour')
  const minute = get('minute')
  const nowMinutes = hour * 60 + minute
  const start = timeToMinutes(nightStart)
  const end = timeToMinutes(nightEnd)
  const inNight = start <= end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end
  return inNight ? nightBrightness : dayBrightness
}

export async function buildMqttScheduleState(): Promise<MqttScheduleState> {
  const [settings] = await db.select().from(deviceSettings).limit(1)
  const timezone = settings?.timezone ?? 'America/Los_Angeles'
  const ledDayBrightness = settings?.ledDayBrightness ?? 100
  const ledNightBrightness = settings?.ledNightBrightness ?? 0
  const currentLedBrightness = computeCurrentLedBrightness(
    timezone,
    settings?.ledNightModeEnabled ?? false,
    settings?.ledNightStartTime ?? null,
    settings?.ledNightEndTime ?? null,
    ledDayBrightness,
    ledNightBrightness,
  )
  const [sides, powers, temps, alarms] = await Promise.all([
    db.select().from(sideSettings),
    db.select().from(powerSchedules),
    db.select().from(temperatureSchedules),
    db.select().from(alarmSchedules),
  ])

  const sideState = (side: Side): SideMqttScheduleState => {
    const sidePowers = powers.filter(row => row.side === side)
    const sideTemps = temps.filter(row => row.side === side)
    const sideAlarms = alarms.filter(row => row.side === side)
    const awayMode = sides.find(row => row.side === side)?.awayMode ?? false
    return {
      side,
      awayMode,
      alarmsEnabled: sideAlarms.some(row => row.enabled),
      bedtime: buildBedtime(sidePowers),
      stageTemperatures: buildStageTemperatures(sidePowers, sideTemps),
      summary: summarizeSide(side, timezone, awayMode, sidePowers, sideTemps, sideAlarms),
    }
  }

  return {
    timezone,
    currentLedBrightness,
    ledDayBrightness,
    ledNightBrightness,
    sides: {
      left: sideState('left'),
      right: sideState('right'),
    },
  }
}

async function ensurePowerRows(side: Side): Promise<PowerRow[]> {
  const existing = await db.select().from(powerSchedules).where(eq(powerSchedules.side, side))
  const existingByDay = firstPowerByDay(existing)
  const created: PowerRow[] = []
  const fallbackOnTemperature = existing[0]?.onTemperature ?? DEFAULT_BEDTIME_TEMPERATURE
  for (const day of SCHEDULE_DAYS) {
    if (existingByDay.has(day)) continue
    const [row] = db
      .insert(powerSchedules)
      .values({
        side,
        dayOfWeek: day,
        onTime: DEFAULT_BEDTIME,
        offTime: DEFAULT_WAKE_TIME,
        onTemperature: fallbackOnTemperature,
        enabled: true,
      })
      .returning()
      .all()
    if (row) created.push(row)
  }
  if (created.length > 0) {
    const jobManager = await getJobManager()
    for (const row of created) jobManager.upsertPowerJob(row)
  }
  return [...existing, ...created]
}

export async function setScheduleBedtime(side: Side, bedtime: string): Promise<void> {
  await ensurePowerRows(side)
  const updated = db
    .update(powerSchedules)
    .set({ onTime: bedtime, updatedAt: new Date() })
    .where(eq(powerSchedules.side, side))
    .returning()
    .all()
  const jobManager = await getJobManager()
  for (const row of updated) jobManager.upsertPowerJob(row)
}

function defaultStageTime(day: DayOfWeek, powers: Map<DayOfWeek, PowerRow>, stage: Exclude<ScheduleStage, 'bedtime'>): string {
  const power = powers.get(day)
  if (!power) return stage === 'asleep' ? '23:00' : '07:00'
  return stage === 'asleep'
    ? minutesToTime(timeToMinutes(power.onTime) + 60)
    : minutesToTime(timeToMinutes(power.offTime) - 60)
}

export async function setScheduleStageTemperature(side: Side, stage: ScheduleStage, temperature: number): Promise<void> {
  const powers = firstPowerByDay(await ensurePowerRows(side))
  const updatedPower: PowerRow[] = []
  const upsertTemp: TemperatureRow[] = []
  if (stage === 'bedtime') {
    const rows = db
      .update(powerSchedules)
      .set({ onTemperature: temperature, updatedAt: new Date() })
      .where(eq(powerSchedules.side, side))
      .returning()
      .all()
    updatedPower.push(...rows)
  }
  else {
    const temps = await db.select().from(temperatureSchedules).where(eq(temperatureSchedules.side, side))
    for (const day of SCHEDULE_DAYS) {
      const entries = relativeTemperatureEntries(day, powers, temps)
      const selected = stage === 'asleep' ? entries[0] : entries.length > 1 ? entries[entries.length - 1] : undefined
      if (selected) {
        const [row] = db
          .update(temperatureSchedules)
          .set({ temperature, updatedAt: new Date() })
          .where(eq(temperatureSchedules.id, selected.id))
          .returning()
          .all()
        if (row) upsertTemp.push(row)
      }
      else {
        const [row] = db
          .insert(temperatureSchedules)
          .values({
            side,
            dayOfWeek: day,
            time: defaultStageTime(day, powers, stage),
            temperature,
            enabled: true,
          })
          .returning()
          .all()
        if (row) upsertTemp.push(row)
      }
    }
  }

  const jobManager = await getJobManager()
  for (const row of updatedPower) jobManager.upsertPowerJob(row)
  for (const row of upsertTemp) jobManager.upsertTemperatureJob(row)
}

export async function setAlarmsEnabled(side: Side, enabled: boolean): Promise<void> {
  const updated = db
    .update(alarmSchedules)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(alarmSchedules.side, side))
    .returning()
    .all()
  const jobManager = await getJobManager()
  for (const row of updated) jobManager.upsertAlarmJob(row)
}

export async function setAwayMode(side: Side, awayMode: boolean): Promise<void> {
  await db
    .update(sideSettings)
    .set({ awayMode, updatedAt: new Date() })
    .where(eq(sideSettings.side, side))
  if (awayMode) {
    const { getSharedHardwareClient } = await import('@/src/hardware/dacMonitor.instance')
    const client = getSharedHardwareClient()
    await client.connect()
    await client.setPower(side, false)
  }
}

export async function setLedBrightness(brightness: number): Promise<void> {
  await db
    .update(deviceSettings)
    .set({
      ledDayBrightness: brightness,
      ledNightBrightness: brightness,
      updatedAt: new Date(),
    })
    .where(eq(deviceSettings.id, 1))
  const jobManager = await getJobManager()
  await jobManager.applyCurrentLedBrightness()
}
