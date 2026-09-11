// @vitest-environment node

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface RecordedInsert {
  table: unknown
  values: unknown
}

const mocks = vi.hoisted(() => {
  const schema = {
    coverButtonActions: { name: 'cover-button-actions-table' },
    deviceSettings: { name: 'device-settings-table' },
    sideSettings: { name: 'side-settings-table' },
    deviceState: { name: 'device-state-table' },
    tapGestures: { name: 'tap-gestures-table' },
  }
  return {
    db: {
      select: vi.fn(),
      transaction: vi.fn(),
    },
    sqlite: { close: vi.fn() },
    biometricsDb: { name: 'biometrics-db' },
    closeBiometricsDatabase: vi.fn(),
    migrate: vi.fn(),
    from: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn(),
    inserts: [] as RecordedInsert[],
    settingsRows: [] as unknown[],
    schema,
  }
})

vi.mock('drizzle-orm/better-sqlite3/migrator', () => ({
  migrate: mocks.migrate,
}))

vi.mock('../index', () => ({
  db: mocks.db,
  sqlite: mocks.sqlite,
}))

vi.mock('../biometrics', () => ({
  biometricsDb: mocks.biometricsDb,
  closeBiometricsDatabase: mocks.closeBiometricsDatabase,
}))

vi.mock('../schema', () => mocks.schema)

const originalArgv1 = process.argv[1]
const migrateModulePath = fileURLToPath(new URL('../migrate.ts', import.meta.url))

async function importMigrate(options: { direct?: boolean } = {}) {
  vi.resetModules()
  process.argv[1] = options.direct ? migrateModulePath : '/not-the-migrate-entrypoint.ts'
  return await import('../migrate')
}

describe('database migration module', () => {
  beforeEach(() => {
    mocks.migrate.mockReset()
    mocks.sqlite.close.mockReset()
    mocks.closeBiometricsDatabase.mockReset()
    mocks.db.select.mockReset()
    mocks.db.transaction.mockReset()
    mocks.from.mockReset()
    mocks.limit.mockReset()
    mocks.insert.mockReset()
    mocks.inserts.length = 0
    mocks.settingsRows = []

    mocks.limit.mockImplementation(async () => mocks.settingsRows)
    mocks.from.mockImplementation(() => ({ limit: mocks.limit }))
    mocks.db.select.mockImplementation(() => ({ from: mocks.from }))
    mocks.insert.mockImplementation((table: unknown) => {
      const command = {
        run: () => {
          mocks.inserts.push({ table, values })
        },
      }
      let values: unknown
      return {
        values: (nextValues: unknown) => {
          values = nextValues
          return {
            ...command,
            onConflictDoNothing: () => command,
          }
        },
      }
    })
    mocks.db.transaction.mockImplementation((callback: (tx: { insert: typeof mocks.insert }) => void) => {
      callback({ insert: mocks.insert })
    })
    process.argv[1] = '/not-the-migrate-entrypoint.ts'
  })

  afterEach(() => {
    process.argv[1] = originalArgv1
    vi.restoreAllMocks()
  })

  it('runs both migration folders and logs successful completion', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runMigrations } = await importMigrate()

    await runMigrations()

    expect(log).toHaveBeenNthCalledWith(1, 'Running database migrations...')
    expect(mocks.migrate.mock.calls).toEqual([
      [mocks.db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') }],
      [mocks.biometricsDb, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') }],
    ])
    expect(log).toHaveBeenNthCalledWith(2, '✓ Database migrations completed successfully')
  })

  it('logs and rethrows a migration failure', async () => {
    const failure = new Error('migration exploded')
    mocks.migrate.mockImplementationOnce(() => {
      throw failure
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { runMigrations } = await importMigrate()

    await expect(runMigrations()).rejects.toBe(failure)
    expect(error).toHaveBeenCalledWith('✗ Database migration failed:', failure)
  })

  it('does not seed when device settings already exist', async () => {
    mocks.settingsRows = [{ id: 7 }]
    const { seedDefaultData } = await importMigrate()

    await seedDefaultData()

    expect(mocks.from).toHaveBeenCalledWith(mocks.schema.deviceSettings)
    expect(mocks.limit).toHaveBeenCalledWith(1)
    expect(mocks.db.transaction).not.toHaveBeenCalled()
    expect(mocks.inserts).toEqual([])
  })

  it('seeds all default rows atomically when device settings are absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { seedDefaultData } = await importMigrate()

    await seedDefaultData()

    expect(mocks.db.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.inserts).toEqual([
      {
        table: mocks.schema.deviceSettings,
        values: {
          id: 1,
          timezone: 'America/Los_Angeles',
          temperatureUnit: 'F',
          rebootDaily: false,
          primePodDaily: false,
          pumpStallProtectionEnabled: false,
        },
      },
      {
        table: mocks.schema.sideSettings,
        values: [
          { side: 'left', name: 'Left', awayMode: false },
          { side: 'right', name: 'Right', awayMode: false },
        ],
      },
      {
        table: mocks.schema.deviceState,
        values: [
          { side: 'left', isPowered: false, isAlarmVibrating: false },
          { side: 'right', isPowered: false, isAlarmVibrating: false },
        ],
      },
      {
        table: mocks.schema.coverButtonActions,
        values: [
          { side: 'left', button: 'top', actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1, temperatureStepMode: 'level' },
          { side: 'left', button: 'middle', actionType: 'power', powerBehavior: 'toggle' },
          { side: 'left', button: 'bottom', actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 1, temperatureStepMode: 'level' },
          { side: 'right', button: 'top', actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1, temperatureStepMode: 'level' },
          { side: 'right', button: 'middle', actionType: 'power', powerBehavior: 'toggle' },
          { side: 'right', button: 'bottom', actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 1, temperatureStepMode: 'level' },
        ],
      },
      {
        table: mocks.schema.tapGestures,
        values: [
          { side: 'left', button: 'top', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1, temperatureStepMode: 'level' },
          { side: 'left', button: 'bottom', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 1, temperatureStepMode: 'level' },
          { side: 'right', button: 'top', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1, temperatureStepMode: 'level' },
          { side: 'right', button: 'bottom', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 1, temperatureStepMode: 'level' },
        ],
      },
    ])
    expect(log).toHaveBeenCalledWith('Seeding default device settings...')
    expect(log).toHaveBeenCalledWith('✓ Default data seeded successfully')
  })

  it('logs and rethrows a seed query failure', async () => {
    const failure = new Error('select exploded')
    mocks.limit.mockRejectedValueOnce(failure)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { seedDefaultData } = await importMigrate()

    await expect(seedDefaultData()).rejects.toBe(failure)
    expect(error).toHaveBeenCalledWith('✗ Failed to seed default data:', failure)
  })

  it('does not run setup side effects when imported as a library', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await importMigrate()
    await Promise.resolve()

    expect(mocks.migrate).not.toHaveBeenCalled()
    expect(mocks.db.select).not.toHaveBeenCalled()
    expect(mocks.closeBiometricsDatabase).not.toHaveBeenCalled()
    expect(mocks.sqlite.close).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('runs setup, closes both databases, and exits zero in direct mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await importMigrate({ direct: true })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))

    expect(mocks.migrate).toHaveBeenCalledTimes(2)
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('✓ Database setup complete')
    expect(mocks.closeBiometricsDatabase).toHaveBeenCalledTimes(1)
    expect(mocks.sqlite.close).toHaveBeenCalledTimes(1)
  })

  it('closes both databases and exits one when direct setup fails', async () => {
    const failure = new Error('direct migration failure')
    mocks.migrate.mockImplementationOnce(() => {
      throw failure
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await importMigrate({ direct: true })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

    expect(error).toHaveBeenCalledWith('✗ Database setup failed:', failure)
    expect(mocks.closeBiometricsDatabase).toHaveBeenCalledTimes(1)
    expect(mocks.sqlite.close).toHaveBeenCalledTimes(1)
  })
})
