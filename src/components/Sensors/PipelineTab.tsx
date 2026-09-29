'use client'

import { DataPipeline } from './DataPipeline'
import { StreamsCard } from './StreamsCard'
import { EventTimeline } from './EventTimeline'
import { RawFrameDrawer } from './RawFrameDrawer'

/** System → Pipeline tab DAG, stream rates, 60s event timeline. */
export function PipelineTab() {
  return (
    <div className="flex flex-col gap-3.5">
      <DataPipeline action={<RawFrameDrawer />} />
      <div className="grid items-start gap-3.5 @min-[760px]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <StreamsCard />
        <EventTimeline />
      </div>
    </div>
  )
}
