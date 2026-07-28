import { NextResponse } from 'next/server'
import { z } from 'zod'
import { dispatchCoverButtonEvent } from '@/src/hardware/dacMonitor.instance'

const coverButtonEventSchema = z.object({
  side: z.enum(['left', 'right']),
  button: z.enum(['top', 'middle', 'bottom']),
  count: z.number().int().min(1).max(4),
  ts: z.number().optional(),
}).strict()

export async function POST(request: Request) {
  let input: z.infer<typeof coverButtonEventSchema>

  try {
    input = coverButtonEventSchema.parse(await request.json())
  }
  catch (error) {
    return NextResponse.json(
      {
        error: 'Invalid cover button event',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    )
  }

  try {
    await dispatchCoverButtonEvent(input)
    return NextResponse.json({ success: true })
  }
  catch (error) {
    console.error('[cover-button] dispatch failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'Cover button dispatch failed' }, { status: 500 })
  }
}
