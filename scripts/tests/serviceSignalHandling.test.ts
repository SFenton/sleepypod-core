// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Next.js's standalone server installs its own SIGTERM/SIGINT handlers that
// call process.exit(143/130) unless NEXT_MANUAL_SIG_HANDLE is set, which kills
// instrumentation.ts's gracefulShutdown before the MQTT bridge can publish
// retained offline and disconnect. Both fresh installs and OTA upgrades must
// carry the env var on sleepypod.service.
const installScript = readFileSync(resolve('scripts/install'), 'utf8')
const updateScript = readFileSync(resolve('scripts/bin/sp-update'), 'utf8')

describe('sleepypod.service signal handling', () => {
  it('fresh install unit sets NEXT_MANUAL_SIG_HANDLE', () => {
    const unitStart = installScript.indexOf('Description=SleepyPod Core Service')
    expect(unitStart).toBeGreaterThan(-1)
    const unit = installScript.slice(unitStart, installScript.indexOf('[Install]', unitStart))
    expect(unit).toContain('Environment="NEXT_MANUAL_SIG_HANDLE=true"')
  })

  it('sp-update self-heals the drop-in for existing pods', () => {
    expect(updateScript).toContain(
      'SIGNAL_HANDLING_DROPIN=/etc/systemd/system/sleepypod.service.d/manual-signal-handling.conf',
    )
    expect(updateScript).toMatch(
      /signal_handling_content=\$\(cat << 'EOF'\n\[Service\]\nEnvironment="NEXT_MANUAL_SIG_HANDLE=true"\nEOF\n\)/,
    )
  })

  it('instrumentation registers its own SIGTERM graceful shutdown', () => {
    const instrumentation = readFileSync(resolve('instrumentation.ts'), 'utf8')
    expect(instrumentation).toContain('process.on(\'SIGTERM\', () => gracefulShutdown(\'SIGTERM\'))')
    expect(instrumentation).toContain('await shutdownMqttBridge()')
  })
})
