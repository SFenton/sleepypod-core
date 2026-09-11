import fs from 'node:fs'
import os from 'node:os'
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

      const telemetryTable = raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'piezo_presence_decisions\'',
      ).get() as { name?: string } | undefined
      expect(telemetryTable?.name).toBe('piezo_presence_decisions')
    }
    finally {
      raw.close()
    }
  })

  it('biometrics journal timestamps are strictly increasing', () => {
    // Drizzle's migrator skips any entry whose `when` is <= the max recorded
    // created_at, so a hand-edited out-of-order journal silently drops
    // migrations on incremental upgrades (pods stuck mid-history).
    const journal = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/biometrics-migrations/meta/_journal.json'),
      'utf-8',
    )) as { entries: Array<{ idx: number, when: number, tag: string }> }

    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]
      const curr = journal.entries[i]
      expect(curr.when, `journal entry ${curr.tag} must have when > ${prev.tag}`)
        .toBeGreaterThan(prev.when)
    }
  })

  it('biometrics DB upgrades incrementally from a db stopped at 0003', () => {
    // Simulate a pod that last migrated at 0003_sensor_calibration, then
    // receives an update with the full migration history. All of 0004+ must
    // apply — with the old out-of-order journal they were silently skipped.
    const migrationsDir = path.resolve(process.cwd(), 'src/db/biometrics-migrations')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biometrics-partial-'))
    const raw = new Database(':memory:')
    try {
      // Build a partial migrations folder containing only entries 0000–0003
      fs.cpSync(migrationsDir, tmpDir, { recursive: true })
      const journalPath = path.join(tmpDir, 'meta/_journal.json')
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
        entries: Array<{ idx: number }>
      }
      journal.entries = journal.entries.filter(e => e.idx <= 3)
      fs.writeFileSync(journalPath, JSON.stringify(journal))

      const db = drizzle(raw, { schema: biometricsSchema })
      migrate(db, { migrationsFolder: tmpDir })

      const tableNames = () => (raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name',
      ).all() as Array<{ name: string }>).map(r => r.name)
      expect(tableNames()).not.toContain('water_level_readings')

      // Incremental upgrade: run the real migrator over the same db
      expect(() => migrate(db, { migrationsFolder: migrationsDir })).not.toThrow()

      const after = tableNames()
      expect(after).toContain('water_level_readings')
      expect(after).toContain('ambient_light')
      expect(after).toContain('water_level_alerts')
    }
    finally {
      raw.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
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
