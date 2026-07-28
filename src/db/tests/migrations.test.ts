import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import * as biometricsSchema from '../biometrics-schema'
import * as schema from '../schema'

describe('migrations smoke test', () => {
  it('main DB migrations apply cleanly from empty', () => {
    const raw = new Database(':memory:')
    try {
      const db = drizzle(raw, { schema })
      expect(() => migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations'),
      })).not.toThrow()

      // Smoke-check that the unique index added in this PR actually exists
      const idx = raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'uq_tap_side_button_type\'',
      ).get() as { name?: string } | undefined
      expect(idx?.name).toBe('uq_tap_side_button_type')

      const buttonIdx = raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'uq_cover_button_side_button\'',
      ).get() as { name?: string } | undefined
      expect(buttonIdx?.name).toBe('uq_cover_button_side_button')

      const coverRows = raw.prepare(
        'SELECT side, button, action_type, temperature_change, temperature_amount, power_behavior FROM cover_button_actions ORDER BY side, button',
      ).all()
      expect(coverRows).toEqual([
        { side: 'left', button: 'bottom', action_type: 'temperature', temperature_change: 'decrement', temperature_amount: 1, power_behavior: null },
        { side: 'left', button: 'middle', action_type: 'power', temperature_change: null, temperature_amount: null, power_behavior: 'toggle' },
        { side: 'left', button: 'top', action_type: 'temperature', temperature_change: 'increment', temperature_amount: 1, power_behavior: null },
        { side: 'right', button: 'bottom', action_type: 'temperature', temperature_change: 'decrement', temperature_amount: 1, power_behavior: null },
        { side: 'right', button: 'middle', action_type: 'power', temperature_change: null, temperature_amount: null, power_behavior: 'toggle' },
        { side: 'right', button: 'top', action_type: 'temperature', temperature_change: 'increment', temperature_amount: 1, power_behavior: null },
      ])

      const buttonGestureRows = raw.prepare(
        'SELECT side, button, tap_type, action_type, temperature_change, temperature_amount, power_behavior FROM tap_gestures WHERE button != \'surface\' ORDER BY side, button, tap_type',
      ).all()
      expect(buttonGestureRows).toEqual([
        { side: 'left', button: 'bottom', tap_type: 'doubleTap', action_type: 'temperature', temperature_change: 'decrement', temperature_amount: 1, power_behavior: null },
        { side: 'left', button: 'top', tap_type: 'doubleTap', action_type: 'temperature', temperature_change: 'increment', temperature_amount: 1, power_behavior: null },
        { side: 'right', button: 'bottom', tap_type: 'doubleTap', action_type: 'temperature', temperature_change: 'decrement', temperature_amount: 1, power_behavior: null },
        { side: 'right', button: 'top', tap_type: 'doubleTap', action_type: 'temperature', temperature_change: 'increment', temperature_amount: 1, power_behavior: null },
      ])

      const deviceStateColumns = raw.prepare('PRAGMA table_info(device_state)').all() as Array<{ name: string }>
      expect(deviceStateColumns.map(column => column.name)).toEqual(expect.arrayContaining([
        'alarm_state',
        'alarm_occurrence_id',
        'alarm_schedule_id',
        'alarm_scheduled_for',
        'alarm_snoozed_until',
        'alarm_ringing_until',
        'alarm_vibration_intensity',
        'alarm_vibration_pattern',
        'alarm_duration',
      ]))
    }
    finally {
      raw.close()
    }
  })

  it('biometrics DB migrations apply cleanly from empty', () => {
    const raw = new Database(':memory:')
    try {
      const db = drizzle(raw, { schema: biometricsSchema })
      expect(() => migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations'),
      })).not.toThrow()

      // After 0007 runs the redundant idx_vitals_side_timestamp must be gone
      const rows = raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'vitals\' ORDER BY name',
      ).all() as Array<{ name: string }>
      const names = rows.map(r => r.name)
      expect(names).toContain('uq_vitals_side_timestamp')
      expect(names).not.toContain('idx_vitals_side_timestamp')
    }
    finally {
      raw.close()
    }
  })

  it('main DB unique index scopes gestures by side, button, and tap count', () => {
    const raw = new Database(':memory:')
    try {
      const db = drizzle(raw, { schema })
      migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations'),
      })

      const insertStmt = raw.prepare(
        'INSERT INTO tap_gestures (side, button, tap_type, action_type) VALUES (?, ?, ?, ?)',
      )
      insertStmt.run('left', 'middle', 'doubleTap', 'power')
      insertStmt.run('right', 'middle', 'doubleTap', 'alarm')
      insertStmt.run('left', 'top', 'tripleTap', 'temperature')

      expect(() => insertStmt.run('left', 'middle', 'doubleTap', 'alarm')).toThrow()
    }
    finally {
      raw.close()
    }
  })
})
