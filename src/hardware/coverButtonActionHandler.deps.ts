import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState, tapGestures } from '@/src/db/schema'
import type { Side } from './types'
import { getSharedHardwareClient } from './dacMonitor.instance'
import type { CoverButton, CoverButtonActionDeps, CoverButtonTapType } from './coverButtonActionHandler'

export const defaultCoverButtonActionDeps: CoverButtonActionDeps = {
  findActionConfig: async (side: Side, button: CoverButton, tapType: CoverButtonTapType) => {
    const [row] = await db
      .select()
      .from(tapGestures)
      .where(and(
        eq(tapGestures.side, side),
        eq(tapGestures.button, button),
        eq(tapGestures.tapType, tapType)
      ))
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
