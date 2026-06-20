import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { fahrenheitToLevel, type Side } from './types'
import { markSideMutated } from './deviceStateSync'

export async function recordTemperatureChange(side: Side, targetTemperature: number): Promise<void> {
  const now = new Date()

  try {
    markSideMutated(side)
    db.transaction((tx) => {
      const [prev] = tx
        .select({
          isPowered: deviceState.isPowered,
          poweredOnAt: deviceState.poweredOnAt,
        })
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)
        .all()

      const poweredOnAt = prev?.isPowered ? prev.poweredOnAt : now

      tx
        .insert(deviceState)
        .values({
          side,
          targetTemperature,
          isPowered: true,
          poweredOnAt,
          lastUpdated: now,
        })
        .onConflictDoUpdate({
          target: deviceState.side,
          set: {
            targetTemperature,
            isPowered: true,
            poweredOnAt,
            lastUpdated: now,
          },
        })
        .run()
    })
  }
  catch (error) {
    console.error('Failed to sync temperature state to DB:', error)
  }

  try {
    const { broadcastMutationStatus } = await import('@/src/streaming/broadcastMutationStatus')
    broadcastMutationStatus(side, {
      targetTemperature,
      targetLevel: fahrenheitToLevel(targetTemperature),
    })
  }
  catch (error) {
    console.error('Failed to broadcast temperature state:', error)
  }
}
