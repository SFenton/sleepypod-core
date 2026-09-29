import { STAGES, type CheckStatus, type NodeId, type Stage } from '@/src/lib/dataPath'
import type { Tone } from '@/src/components/ds'

// Geometry for the data-path map, in SVG user units.
export const MAP = {
  colGap: 196,
  nodeW: 152,
  nodeH: 50,
  rowH: 64,
  top: 26,
  padX: 4,
} as const

export interface PlacedNode { id: NodeId, stage: Stage, x: number, y: number }

/** Columns by stage, each column centred on the tallest one. */
export function layoutMap(nodes: ReadonlyArray<{ id: NodeId, stage: Stage }>) {
  const cols = STAGES.map(s => nodes.filter(n => n.stage === s.id))
  const rows = Math.max(...cols.map(c => c.length))
  const placed: PlacedNode[] = cols.flatMap((col, ci) => col.map((n, ri) => ({
    id: n.id,
    stage: n.stage,
    x: MAP.padX + ci * MAP.colGap,
    y: MAP.top + ((rows - col.length) * MAP.rowH) / 2 + ri * MAP.rowH,
  })))
  return {
    placed,
    width: MAP.padX * 2 + (STAGES.length - 1) * MAP.colGap + MAP.nodeW,
    laneY: MAP.top + rows * MAP.rowH - (MAP.rowH - MAP.nodeH) + LANE_GAP / 2,
    height: MAP.top + rows * MAP.rowH - (MAP.rowH - MAP.nodeH) + LANE_GAP,
    stageX: STAGES.map((s, i) => ({ ...s, x: MAP.padX + i * MAP.colGap })),
  }
}

/** Links that skip a column run along this lane under the nodes instead of through them. */
export const LANE_GAP = 22

/** Link from the right edge of one node to the left edge of another. */
export function edgePath(a: PlacedNode, b: PlacedNode, laneY: number): string {
  const x1 = a.x + MAP.nodeW
  const y1 = a.y + MAP.nodeH / 2
  const x2 = b.x
  const y2 = b.y + MAP.nodeH / 2
  if (x2 - x1 > MAP.colGap) {
    const r = 18
    const out = x1 + (MAP.colGap - MAP.nodeW) / 2
    const back = x2 - (MAP.colGap - MAP.nodeW) / 2
    return `M${x1},${y1} L${out - r},${y1} Q${out},${y1} ${out},${y1 + r} L${out},${laneY - r} Q${out},${laneY} ${out + r},${laneY} `
      + `L${back - r},${laneY} Q${back},${laneY} ${back},${laneY - r} L${back},${y2 + r} Q${back},${y2} ${back + r},${y2} L${x2},${y2}`
  }
  const bend = Math.min(80, (x2 - x1) / 2)
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
}

export const STATUS_TONE: Record<CheckStatus, Tone> = {
  ok: 'ok',
  idle: 'muted',
  stale: 'warn',
  down: 'danger',
  unknown: 'muted',
}

export const STATUS_WORD: Record<CheckStatus, string> = {
  ok: 'flowing',
  idle: 'idle',
  stale: 'stalled',
  down: 'down',
  unknown: 'unknown',
}

/** Strip fill per status; idle is healthy-but-quiet, so it recedes. */
export const STATUS_FILL: Record<CheckStatus, string> = {
  ok: 'bg-ok',
  idle: 'bg-line-2',
  stale: 'bg-warn',
  down: 'bg-danger',
  unknown: 'bg-fg-3/40',
}

export function fmtSpan(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

export function fmtClockMs(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A problem shorter than this is a blip; more than two in a day is recurring. */
const BLIP_MS = 5 * 60_000
const RECURRING = 3

export interface IncidentLine {
  key: string
  tone: Tone
  title: string
  when: string
  /** "blip" · "recurring" · "ongoing" — how to read it. */
  tag: 'blip' | 'recurring' | 'ongoing' | null
  detail: string | null
}

export function incidentLines(
  history: {
    incidents: Array<{ checkId: NodeId, label: string, status: 'stale' | 'down', start: number, end: number | null, detail: string | null }>
    gaps: Array<{ start: number, end: number }>
    checks: Array<{ id: NodeId, incidents: number }>
  },
  now: number,
): IncidentLine[] {
  const counts = new Map(history.checks.map(c => [c.id, c.incidents]))
  const lines: Array<{ line: IncidentLine, sortAt: number }> = history.incidents.map((i) => {
    const end = i.end ?? now
    const tag = i.end == null ? 'ongoing' : (counts.get(i.checkId) ?? 0) >= RECURRING ? 'recurring' : end - i.start < BLIP_MS ? 'blip' : null
    return {
      line: {
        key: `${i.checkId}-${i.start}`,
        tone: i.status === 'down' ? 'danger' : 'warn',
        title: `${i.label} ${i.status === 'down' ? 'down' : 'stalled'}`,
        when: `${fmtClockMs(i.start)} – ${i.end == null ? 'now' : fmtClockMs(i.end)} · ${fmtSpan(end - i.start)}`,
        tag,
        detail: i.detail,
      },
      sortAt: end,
    }
  })
  for (const g of history.gaps) {
    lines.push({
      line: {
        key: `gap-${g.start}`,
        tone: 'muted',
        title: 'Not recorded',
        when: `${fmtClockMs(g.start)} – ${g.end >= now - 60_000 ? 'now' : fmtClockMs(g.end)} · ${fmtSpan(g.end - g.start)}`,
        tag: null,
        detail: 'The core service wasn’t running, so nothing was checked.',
      },
      sortAt: g.end,
    })
  }
  return lines.sort((a, b) => b.sortAt - a.sortAt).map(l => l.line)
}
