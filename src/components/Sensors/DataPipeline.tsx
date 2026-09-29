'use client'

import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ReactFlow,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowDown } from 'lucide-react'
import { Card, CardHeader } from '@/src/components/ds'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Pipeline graph: Firmware → (dacTransport, RAW Files) → (DacMonitor,
// piezoStream) → broadcastFrame() → WebSocket :3001 → Browser, with tRPC
// :3000 feeding dacTransport (the write path).
// ---------------------------------------------------------------------------

interface PipelineNodeData {
  label: string
  sub: string
  color: string
  [key: string]: unknown
}

const HANDLE_SIDES = [['l', Position.Left], ['r', Position.Right], ['t', Position.Top], ['b', Position.Bottom]] as const

const HIDDEN_HANDLE = { visibility: 'hidden' as const, width: 0, height: 0, minWidth: 0, minHeight: 0, border: 0 }

export function PipelineNodeBox({ label, sub, color, children }: { label: string, sub: string, color: string, children?: ReactNode }) {
  return (
    <div className="flex w-[150px] min-w-0 flex-col gap-[3px] rounded-ctl border border-line-2 bg-app px-[11px] py-[9px] text-fg">
      {children}
      <span className="flex items-center gap-[7px] truncate text-[13px] leading-tight">
        <span className="block size-[7px] shrink-0 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="truncate font-mono text-[11px] leading-tight text-fg-2">{sub}</span>
    </div>
  )
}

function PipelineNode({ data }: { data: PipelineNodeData }) {
  return (
    <PipelineNodeBox label={data.label} sub={data.sub} color={data.color}>
      {HANDLE_SIDES.map(([id, position]) => (
        <Fragment key={id}>
          <Handle id={`s${id}`} type="source" position={position} style={HIDDEN_HANDLE} />
          <Handle id={`t${id}`} type="target" position={position} style={HIDDEN_HANDLE} />
        </Fragment>
      ))}
    </PipelineNodeBox>
  )
}

const NODE_TYPES = { pipeline: PipelineNode }

const COL = 190
const ROW = 76

export const PIPELINE_NODES: Array<{ id: string, label: string, sub: string, color: string, x: number, y: number }> = [
  { id: 'firmware', label: 'Firmware', sub: 'frankenfirmware', color: 'var(--text-3)', x: 0, y: ROW / 2 },
  { id: 'dac-transport', label: 'dacTransport', sub: 'dac.sock', color: 'var(--text-2)', x: COL, y: 0 },
  { id: 'raw', label: 'RAW Files', sub: 'CBOR on disk', color: 'var(--text-3)', x: COL, y: ROW },
  { id: 'dac-monitor', label: 'DacMonitor', sub: 'polls 2s', color: 'var(--accent-cool)', x: COL * 2, y: 0 },
  { id: 'piezo-stream', label: 'piezoStream', sub: 'tails + parses', color: 'var(--stage-rem)', x: COL * 2, y: ROW },
  { id: 'broadcast', label: 'broadcastFrame()', sub: 'event bus', color: 'var(--stage-rem)', x: COL * 3, y: ROW / 2 },
  { id: 'ws', label: 'WebSocket :3001', sub: 'sensor frames', color: 'var(--stage-rem)', x: COL * 4, y: ROW / 2 },
  { id: 'browser', label: 'Browser', sub: 'React UI', color: 'var(--text-1)', x: COL * 5, y: ROW / 2 },
  { id: 'trpc', label: 'tRPC :3000', sub: 'mutations', color: 'var(--accent-warm)', x: COL, y: -ROW - 10 },
]

const STATIC_NODES: Node[] = PIPELINE_NODES.map(n => ({
  id: n.id,
  type: 'pipeline',
  position: { x: n.x, y: n.y },
  data: { label: n.label, sub: n.sub, color: n.color },
}))

const READ = { stroke: 'var(--text-3)', strokeWidth: 1.25 }
const WRITE = { stroke: 'var(--accent-warm)', strokeWidth: 1.25, strokeDasharray: '5 4' }
const ARROW_READ = { type: MarkerType.ArrowClosed, color: 'var(--text-3)', width: 14, height: 14 }
const ARROW_WRITE = { type: MarkerType.ArrowClosed, color: 'var(--accent-warm)', width: 14, height: 14 }

function edge(id: string, source: string, target: string, write = false, handles: [string, string] = ['sr', 'tl']): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: handles[0],
    targetHandle: handles[1],
    type: 'smoothstep',
    style: write ? WRITE : READ,
    markerEnd: write ? ARROW_WRITE : ARROW_READ,
  }
}

const STATIC_EDGES: Edge[] = [
  edge('fw-dt', 'firmware', 'dac-transport'),
  edge('fw-raw', 'firmware', 'raw'),
  edge('dt-dm', 'dac-transport', 'dac-monitor'),
  edge('raw-ps', 'raw', 'piezo-stream'),
  edge('dm-bc', 'dac-monitor', 'broadcast'),
  edge('ps-bc', 'piezo-stream', 'broadcast'),
  edge('bc-ws', 'broadcast', 'ws'),
  edge('ws-browser', 'ws', 'browser'),
  edge('browser-trpc', 'browser', 'trpc', true, ['st', 'tr']),
  edge('trpc-dt', 'trpc', 'dac-transport', true, ['sb', 'tt']),
]

const FIT_VIEW_OPTIONS = { padding: 0.08 }
const PRO_OPTIONS = { hideAttribution: true }

/**
 * ReactFlow is isolated inside a memo'd zero-prop component with all data
 * as module-level constants, so parent re-renders never reach its store.
 */
const StaticDag = memo(function StaticDag() {
  return (
    <div className="h-[240px]">
      <ReactFlow
        nodes={STATIC_NODES}
        edges={STATIC_EDGES}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        elementsSelectable={false}
        proOptions={PRO_OPTIONS}
        style={{ background: 'transparent' }}
      />
    </div>
  )
})

/** Narrow containers: the same stages as a vertical list. */
function StackedDag() {
  const order = ['firmware', 'dac-transport', 'dac-monitor', 'broadcast', 'ws', 'browser']
  const nodes = order.flatMap(id => PIPELINE_NODES.filter(n => n.id === id))
  return (
    <div className="flex flex-col items-stretch gap-1.5">
      {nodes.map((n, i) => (
        <div key={n.id} className="flex flex-col items-center gap-1.5">
          <div className="w-full [&>div]:w-full">
            <PipelineNodeBox label={n.label} sub={n.sub} color={n.color} />
          </div>
          {i < nodes.length - 1 && <ArrowDown size={14} className="text-fg-3" />}
        </div>
      ))}
    </div>
  )
}

/** Width of an element, tracked with ResizeObserver (0 until measured). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/**
 * Data pipeline card: how a frame travels from the firmware to this page.
 * Full DAG when there is room, a vertical stage list on phones.
 */
export function DataPipeline({ action }: { action?: ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  return (
    <Card>
      <CardHeader
        title="Data pipeline"
        subtitle="How a frame travels from the firmware to this page"
        right={action}
      />
      <div ref={ref} className="min-w-0">
        {width === 0 ? null : width >= 640 ? <StaticDag /> : <StackedDag />}
      </div>
      <div className={cn('flex gap-4 font-mono text-[11px] text-fg-2', width < 640 && 'hidden')}>
        <span className="flex items-center gap-1.5">
          <span className="block h-px w-3.5 bg-fg-3" />
          read
        </span>
        <span className="flex items-center gap-1.5">
          <span className="block w-3.5 border-t border-dashed border-warm" />
          write
        </span>
      </div>
    </Card>
  )
}
