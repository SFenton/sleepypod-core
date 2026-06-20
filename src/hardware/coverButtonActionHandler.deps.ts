import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { coverButtonActions, deviceState } from '@/src/db/schema'
import type { Side } from './types'
import { getSharedHardwareClient } from './dacMonitor.instance'
import type { CoverButton, CoverButtonActionDeps } from './coverButtonActionHandler'

export const defaultCoverButtonActionDeps: CoverButtonActionDeps = {
  findActionConfig: async (side: Side, button: CoverButton) => {
    const [row] = await db
      .select()
      .from(coverButtonActions)
      .where(and(eq(coverButtonActions.side, side), eq(coverButtonActions.button, button)))
      .limit(1)
    return row ?? null
  },

  findDeviceState: async (side: Side) => {
    const [row] = await db
      .select()
      .from(deviceState)
      .where(eq(deviceState.side, side))
      .limit(1)
    return row ?? null
  },

  newHardwareClient: () => getSharedHardwareClient(),
}
