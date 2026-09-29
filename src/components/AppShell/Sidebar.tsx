'use client'

import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { Badge, StatusDot } from '@/src/components/ds/core'
import { resolveSection, SECTIONS } from '@/src/components/Settings/sections'
import { resolveSystemTab, SYSTEM_TABS } from '@/src/components/System/systemTabs'
import { AUTOPILOT_VIEWS, resolveAutopilotView } from '@/src/components/Autopilot/autopilotViews'
import { resolveSleepSection, SLEEP_SECTIONS } from '@/src/components/Sleep/sleepViews'
import { attentionItems } from '@/src/components/diagnostics/dashboardLogic'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { trpc } from '@/src/utils/trpc'
import { buildLine, footerStatus } from './footerStatus'
import { activeNavId, DOCS_URL, langFromPath, NAV_ITEMS, type NavId } from './navItems'

const noopSubscribe = () => () => {}

const POD_NAMES: Record<string, string> = { H00: 'Pod 3', I00: 'Pod 4', J00: 'Pod 5' }

/** Desktop navigation rail (≥ 900px). */
export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = activeNavId(pathname)

  const status = trpc.device.getStatus.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const health = trpc.health.system.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const version = trpc.system.getVersion.useQuery({}, { staleTime: 60_000 })
  const maintenance = trpc.health.maintenance.useQuery({}, { staleTime: 30_000, refetchInterval: 60_000 })
  const water = trpc.waterLevel.getLatest.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const nowMinute = useNowMinute()

  const podName = status.data?.podVersion ? POD_NAMES[status.data.podVersion] ?? status.data.podVersion : 'Pod'
  const attention = nowMinute == null
    ? []
    : attentionItems(maintenance.data, water.data?.level ?? status.data?.waterLevel, nowMinute * 60_000)
  const footer = footerStatus(health.data, attention)
  const statusDot = footer.tone === 'muted' ? undefined : footer.tone
  const host = useSyncExternalStore(noopSubscribe, () => window.location.hostname, () => '')
  const build = buildLine(version.data)
  const commit = version.data?.commitHash && version.data.commitHash !== 'unknown' ? version.data.commitHash.slice(0, 7) : null

  return (
    <nav
      aria-label="Main"
      className={cn('sticky top-0 flex h-dvh w-[224px] shrink-0 flex-col gap-7 border-r border-line px-3.5 py-6', className)}
    >
      <div className="flex items-center gap-2.5 px-2.5">
        <Link href={`/${lang}`} className="flex min-w-0 items-center gap-2 font-mono text-sm text-fg no-underline hover:no-underline">
          {/* eslint-disable-next-line @next/next/no-img-element -- static 128px asset, no optimizer needed on the pod */}
          <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-[6px]" />
          sleepypod
        </Link>
        <BuildTag version={version.data?.version ?? null} dev={!!commit} branch={version.data?.branch} />
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {NAV_ITEMS.map((n) => {
          const on = n.id === active
          const group = n.id === 'autopilot' || n.id === 'sleep' || n.id === 'settings' || n.id === 'system'
          const Chevron = on ? ChevronDown : ChevronRight
          return (
            <div key={n.id} className="flex flex-col gap-0.5">
              <Link
                href={`/${lang}${n.href === '/' ? '' : n.href}`}
                aria-current={on && !group ? 'page' : undefined}
                aria-expanded={group ? on : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-ctl px-2.5 py-[9px] text-sm no-underline transition-colors hover:no-underline',
                  on ? (group ? 'text-fg hover:bg-active' : 'bg-active text-fg') : 'text-fg-2 hover:bg-active',
                )}
              >
                <n.icon size={16} />
                {n.label}
                {group && <Chevron size={14} className="ml-auto text-fg-3" />}
              </Link>
              {group && on && (
                <Suspense fallback={null}>
                  <SubTree group={n.id as 'autopilot' | 'sleep' | 'settings' | 'system'} lang={lang} statusDot={statusDot} />
                </Suspense>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-auto flex flex-col gap-1 border-t border-line pt-2">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-ctl px-2.5 py-2 text-sm text-fg-2 no-underline transition-colors hover:bg-active hover:text-fg hover:no-underline"
        >
          <BookOpen size={16} />
          Docs
          <ArrowUpRight size={14} className="ml-auto text-fg-3" />
        </a>
        <Link
          href={`/${lang}/system`}
          title={footer.issues.length > 0 ? footer.issues.join('\n') : undefined}
          className="group flex flex-col gap-1 rounded-ctl px-2.5 py-2 font-mono text-xs text-fg-2 no-underline transition-colors hover:bg-active hover:no-underline"
        >
          <div className="flex items-center gap-2 text-fg">
            <StatusDot tone={footer.tone} />
            {podName}
            <span className={cn('truncate', footer.tone === 'warn' ? 'text-warn' : 'text-fg-2')}>
              {'· '}
              {footer.summary}
            </span>
            <ChevronRight size={14} className="ml-auto shrink-0 text-fg-3 group-hover:text-fg-2" />
          </div>
          {footer.issues.length > 0 && (
            <div className="truncate pl-3.5 text-warn">{footer.issues[0]}</div>
          )}
          <span className="sr-only">Open System dashboard</span>
          <div className="truncate pl-3.5">{[host, build?.commit].filter(Boolean).join(' · ')}</div>
          {build?.branch && <div className="truncate pl-3.5" title={build.branch} data-testid="footer-branch">{build.branch}</div>}
        </Link>
      </div>
    </nav>
  )
}

/**
 * Sections nested under their parent (Autopilot, Sleep, Settings, System), indented along a
 * hairline without icons. Only the current group is expanded.
 */
function SubTree({ group, lang, statusDot }: {
  group: Extract<NavId, 'autopilot' | 'sleep' | 'settings' | 'system'>
  lang: string
  statusDot?: 'ok' | 'warn'
}) {
  const searchParams = useSearchParams()
  let items: Array<{ id: string, label: string, href: string, dot?: 'ok' | 'warn' }>
  let current: string
  if (group === 'settings') {
    items = SECTIONS.map(sec => ({
      id: sec.id,
      label: sec.label,
      href: `/${lang}/settings?section=${sec.id}`,
    }))
    current = resolveSection(searchParams.get('section'), searchParams.get('tab')) ?? SECTIONS[0].id
  }
  else if (group === 'system') {
    items = SYSTEM_TABS.map(t => ({
      id: t.id,
      label: t.label,
      href: t.id === 'dashboard' ? `/${lang}/system` : `/${lang}/system?tab=${t.id}`,
      dot: t.id === 'dashboard' ? statusDot : undefined,
    }))
    current = resolveSystemTab(searchParams.get('tab'), searchParams.get('section'))
  }
  else if (group === 'sleep') {
    items = SLEEP_SECTIONS.map(sec => ({
      id: sec.id,
      label: sec.label,
      href: sec.id === 'nights' ? `/${lang}/sleep` : `/${lang}/sleep?view=${sec.id}`,
    }))
    current = resolveSleepSection(searchParams.get('view'))
  }
  else {
    items = AUTOPILOT_VIEWS.map(v => ({
      id: v.id,
      label: v.label,
      href: v.id === 'automations' ? `/${lang}/autopilot` : `/${lang}/autopilot?view=${v.id}`,
    }))
    current = resolveAutopilotView(searchParams.get('view'))
  }

  return (
    <div className="mb-1 ml-[17px] flex flex-col gap-0.5 border-l border-line pl-2">
      {items.map((it) => {
        const on = it.id === current
        return (
          <Link
            key={it.id}
            href={it.href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-ctl px-2.5 py-[7px] text-sm no-underline transition-colors hover:no-underline',
              on ? 'bg-active text-fg' : 'text-fg-2 hover:bg-active',
            )}
          >
            {it.label}
            {it.dot && <StatusDot tone={it.dot} className="ml-auto" />}
          </Link>
        )
      })}
    </div>
  )
}

/**
 * Tagged release → the version in a neutral chip. Anything else (dev, feature
 * branches, local builds) → an amber DEV chip, with the branch on hover; the
 * footer spells out branch and commit.
 */
function BuildTag({ version, dev, branch }: { version: string | null, dev: boolean, branch?: string }) {
  if (version) return <Badge className="ml-auto shrink-0 text-[10px]">{version}</Badge>
  if (!dev) return null
  return (
    <span className="ml-auto flex shrink-0" title={branch && branch !== 'unknown' ? branch : undefined}>
      <Badge className="border-warn-line bg-warn-bg text-[10px] tracking-[0.06em] text-warn">DEV</Badge>
    </span>
  )
}
