/**
 * Sensor-stream groups shared by the Pipeline tab (Streams table and the
 * 60s event timeline). Colors are CSS tokens so both themes work.
 */
export interface StreamGroup {
  key: string
  /** Streams-table label. */
  label: string
  /** Timeline lane label. */
  lane: string
  color: string
  /** Frame types (useSensorStream `type`) that belong to this group. */
  types: readonly string[]
}

export const STREAM_GROUPS: readonly StreamGroup[] = [
  { key: 'status', label: 'Device', lane: 'STS', color: 'var(--accent-neutral)', types: ['deviceStatus'] },
  { key: 'piezo', label: 'Piezo', lane: 'PZO', color: 'var(--stage-rem)', types: ['piezo-dual', 'lps'] },
  { key: 'presence', label: 'Presence', lane: 'CAP', color: 'var(--status-ok)', types: ['capSense2', 'capSense'] },
  { key: 'bedTemp', label: 'Bed Temp', lane: 'TMP', color: 'var(--accent-warm)', types: ['bedTemp2', 'bedTemp'] },
  { key: 'freezer', label: 'Freezer', lane: 'FRZ', color: 'var(--accent-cool)', types: ['frzHealth', 'frzTemp', 'frzTherm'] },
  { key: 'log', label: 'Log', lane: 'LOG', color: 'var(--status-warn)', types: ['log', 'gesture'] },
]

const TYPE_TO_GROUP = new Map<string, string>()
for (const g of STREAM_GROUPS) {
  for (const t of g.types) TYPE_TO_GROUP.set(t, g.key)
}

export function groupForType(type: string): string | undefined {
  return TYPE_TO_GROUP.get(type)
}

/** Compact age string for "last seen": 0.1s, 12s, 4m, 2h. */
export function fmtSeen(ageMs: number | null): string {
  if (ageMs === null) return '—'
  const s = ageMs / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
