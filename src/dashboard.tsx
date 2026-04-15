import { homedir } from 'os'

import React, { useState, useCallback, useEffect } from 'react'
import { render, Box, Text, useInput, useApp, useWindowSize } from 'ink'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { formatCost, formatTokens } from './format.js'
import { parseAllSessions } from './parser.js'
import { loadPricing } from './models.js'
import { providers } from './providers/index.js'

type Period = 'today' | 'week' | 'month' | '30days'

const PERIODS: Period[] = ['today', 'week', '30days', 'month']
const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today',
  week: '7 Days',
  '30days': '30 Days',
  month: 'This Month',
}

const MIN_WIDE = 90
const ORANGE = '#FF8C42'
const DIM = '#555555'
const GOLD = '#FFD700'

const PANEL_COLORS = {
  overview: '#FF8C42',
  daily: '#5B9EF5',
  project: '#5BF5A0',
  model: '#E05BF5',
  activity: '#F5C85B',
  tools: '#5BF5E0',
  mcp: '#F55BE0',
  bash: '#F5A05B',
}

const CATEGORY_COLORS: Record<TaskCategory, string> = {
  coding: '#5B9EF5',
  debugging: '#F55B5B',
  feature: '#5BF58C',
  refactoring: '#F5E05B',
  testing: '#E05BF5',
  exploration: '#5BF5E0',
  planning: '#7B9EF5',
  delegation: '#F5C85B',
  git: '#CCCCCC',
  'build/deploy': '#5BF5A0',
  conversation: '#888888',
  brainstorming: '#F55BE0',
  general: '#666666',
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

// Blue -> amber -> orange gradient across the bar width
function gradientColor(pct: number): string {
  if (pct <= 0.33) {
    const t = pct / 0.33
    return toHex(lerp(91, 245, t), lerp(158, 200, t), lerp(245, 91, t))
  }
  if (pct <= 0.66) {
    const t = (pct - 0.33) / 0.33
    return toHex(lerp(245, 255, t), lerp(200, 140, t), lerp(91, 66, t))
  }
  const t = (pct - 0.66) / 0.34
  return toHex(lerp(255, 245, t), lerp(140, 91, t), lerp(66, 91, t))
}

function getDateRange(period: Period): { start: Date; end: Date } {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  switch (period) {
    case 'today': return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()), end }
    case 'week': return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7), end }
    case '30days': return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30), end }
    case 'month': return { start: new Date(now.getFullYear(), now.getMonth(), 1), end }
  }
}

type Layout = { dashWidth: number; wide: boolean; halfWidth: number; barWidth: number }

function getLayout(columns?: number): Layout {
  const termWidth = columns || parseInt(process.env['COLUMNS'] ?? '') || 80
  const dashWidth = Math.min(160, termWidth)
  const wide = dashWidth >= MIN_WIDE
  const halfWidth = wide ? Math.floor(dashWidth / 2) : dashWidth
  const inner = halfWidth - 4
  const barWidth = Math.max(6, Math.min(10, inner - 30))
  return { dashWidth, wide, halfWidth, barWidth }
}

function HBar({ value, max, width }: { value: number; max: number; width: number }) {
  if (max === 0) return <Text color={DIM}>{'░'.repeat(width)}</Text>
  const filled = Math.round((value / max) * width)
  const fillChars: React.ReactNode[] = []
  for (let i = 0; i < Math.min(filled, width); i++) {
    fillChars.push(<Text key={i} color={gradientColor(i / width)}>{'█'}</Text>)
  }
  return (
    <Text>
      {fillChars}
      <Text color="#333333">{'░'.repeat(Math.max(width - filled, 0))}</Text>
    </Text>
  )
}

function Panel({ title, color, children, width }: { title: string; color: string; children: React.ReactNode; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width} overflowX="hidden">
      <Text bold color={color}>{title}</Text>
      {children}
    </Box>
  )
}

function fit(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s.padEnd(n)
}

function Overview({ projects, label, width }: { projects: ProjectSummary[]; label: string; width: number }) {
  const totalCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const allSessions = projects.flatMap(p => p.sessions)
  const totalInput = allSessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = allSessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = allSessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = allSessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  const cacheHit = totalInput + totalCacheRead > 0
    ? (totalCacheRead / (totalInput + totalCacheRead)) * 100 : 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={PANEL_COLORS.overview} paddingX={1} width={width}>
      <Text wrap="truncate-end">
        <Text bold color={ORANGE}>CodeBurn</Text>
        <Text dimColor>  {label}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text bold color={GOLD}>{formatCost(totalCost)}</Text>
        <Text dimColor> cost   </Text>
        <Text bold>{totalCalls.toLocaleString()}</Text>
        <Text dimColor> calls   </Text>
        <Text bold>{String(totalSessions)}</Text>
        <Text dimColor> sessions   </Text>
        <Text bold>{cacheHit.toFixed(0)}%</Text>
        <Text dimColor> cache hit</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {formatTokens(totalInput)} in   {formatTokens(totalOutput)} out   {formatTokens(totalCacheRead)} cached   {formatTokens(totalCacheWrite)} written
      </Text>
    </Box>
  )
}

function DailyActivity({ projects, days = 14, pw, bw }: { projects: ProjectSummary[]; days?: number; pw: number; bw: number }) {
  const dailyCosts: Record<string, number> = {}
  const dailyCalls: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = turn.timestamp.slice(0, 10)
        dailyCosts[day] = (dailyCosts[day] ?? 0) + turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        dailyCalls[day] = (dailyCalls[day] ?? 0) + turn.assistantCalls.length
      }
    }
  }
  const sortedDays = Object.keys(dailyCosts).sort().slice(-days)
  const maxCost = Math.max(...sortedDays.map(d => dailyCosts[d] ?? 0))

  return (
    <Panel title="Daily Activity" color={PANEL_COLORS.daily} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(6 + bw)}{'cost'.padStart(8)}{'calls'.padStart(6)}</Text>
      {sortedDays.map(day => (
        <Text key={day} wrap="truncate-end">
          <Text dimColor>{day.slice(5)} </Text>
          <HBar value={dailyCosts[day] ?? 0} max={maxCost} width={bw} />
          <Text color={GOLD}>{formatCost(dailyCosts[day] ?? 0).padStart(8)}</Text>
          <Text>{String(dailyCalls[day] ?? 0).padStart(6)}</Text>
        </Text>
      ))}
    </Panel>
  )
}

const _homeEncoded = homedir().replace(/\//g, '-')

function shortProject(encoded: string): string {
  let path = encoded.replace(/^-/, '')

  // Strip home dir prefix (e.g. "Users-torukmakto-" → "")
  if (path.startsWith(_homeEncoded.replace(/^-/, ''))) {
    path = path.slice(_homeEncoded.replace(/^-/, '').length).replace(/^-/, '')
  }

  // Strip common system prefixes
  path = path
    .replace(/^private-tmp-[^-]+-[^-]+-/, '')  // /private/tmp/<org>/<env>/
    .replace(/^private-tmp-/, '')
    .replace(/^tmp-/, '')

  if (!path) return '~'

  const parts = path.split('-').filter(Boolean)
  if (parts.length <= 3) return parts.join('/')
  return parts.slice(-3).join('/')
}

function ProjectBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const maxCost = Math.max(...projects.map(p => p.totalCostUSD))
  const nw = Math.max(8, pw - bw - 23)
  return (
    <Panel title="By Project" color={PANEL_COLORS.project} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'cost'.padStart(8)}{'sess'.padStart(6)}</Text>
      {projects.slice(0, 8).map((project, i) => (
        <Text key={`${project.project}-${i}`} wrap="truncate-end">
          <HBar value={project.totalCostUSD} max={maxCost} width={bw} />
          <Text dimColor> {fit(shortProject(project.project), nw)}</Text>
          <Text color={GOLD}>{formatCost(project.totalCostUSD).padStart(8)}</Text>
          <Text>{String(project.sessions.length).padStart(6)}</Text>
        </Text>
      ))}
    </Panel>
  )
}

function ModelBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const modelTotals: Record<string, { calls: number; costUSD: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) modelTotals[model] = { calls: 0, costUSD: 0 }
        modelTotals[model].calls += data.calls
        modelTotals[model].costUSD += data.costUSD
      }
    }
  }
  const sorted = Object.entries(modelTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD)
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0
  const nw = Math.max(6, pw - bw - 25)

  return (
    <Panel title="By Model" color={PANEL_COLORS.model} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'cost'.padStart(8)}{'calls'.padStart(7)}</Text>
      {sorted.map(([model, data], i) => (
        <Text key={`${model}-${i}`} wrap="truncate-end">
          <HBar value={data.costUSD} max={maxCost} width={bw} />
          <Text> {fit(model, nw)}</Text>
          <Text color={GOLD}>{formatCost(data.costUSD).padStart(8)}</Text>
          <Text>{String(data.calls).padStart(7)}</Text>
        </Text>
      ))}
    </Panel>
  )
}

function ActivityBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const categoryTotals: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, data] of Object.entries(session.categoryBreakdown)) {
        if (!categoryTotals[cat]) categoryTotals[cat] = { turns: 0, costUSD: 0, editTurns: 0, oneShotTurns: 0 }
        categoryTotals[cat].turns += data.turns
        categoryTotals[cat].costUSD += data.costUSD
        categoryTotals[cat].editTurns += data.editTurns
        categoryTotals[cat].oneShotTurns += data.oneShotTurns
      }
    }
  }
  const sorted = Object.entries(categoryTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD)
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0

  return (
    <Panel title="By Activity" color={PANEL_COLORS.activity} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 14)}{'cost'.padStart(8)}{'turns'.padStart(6)}{'1-shot'.padStart(7)}</Text>
      {sorted.map(([cat, data]) => {
        const oneShotPct = data.editTurns > 0 ? Math.round((data.oneShotTurns / data.editTurns) * 100) + '%' : '-'
        return (
          <Text key={cat} wrap="truncate-end">
            <HBar value={data.costUSD} max={maxCost} width={bw} />
            <Text color={CATEGORY_COLORS[cat as TaskCategory] ?? '#666666'}>
              {' '}{fit(CATEGORY_LABELS[cat as TaskCategory] ?? cat, 13)}
            </Text>
            <Text color={GOLD}>{formatCost(data.costUSD).padStart(8)}</Text>
            <Text>{String(data.turns).padStart(6)}</Text>
            <Text color={data.editTurns === 0 ? DIM : oneShotPct === '100%' ? '#5BF58C' : ORANGE}>{String(oneShotPct).padStart(7)}</Text>
          </Text>
        )
      })}
    </Panel>
  )
}

function ToolBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const toolTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, data] of Object.entries(session.toolBreakdown)) {
        toolTotals[tool] = (toolTotals[tool] ?? 0) + data.calls
      }
    }
  }
  const sorted = Object.entries(toolTotals).sort(([, a], [, b]) => b - a)
  const maxCalls = sorted[0]?.[1] ?? 0
  const nw = Math.max(6, pw - bw - 15)

  return (
    <Panel title="Core Tools" color={PANEL_COLORS.tools} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'calls'.padStart(7)}</Text>
      {sorted.slice(0, 10).map(([tool, calls]) => (
        <Text key={tool} wrap="truncate-end">
          <HBar value={calls} max={maxCalls} width={bw} />
          <Text> {fit(tool, nw)}</Text>
          <Text>{String(calls).padStart(7)}</Text>
        </Text>
      ))}
    </Panel>
  )
}

function McpBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const mcpTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [server, data] of Object.entries(session.mcpBreakdown)) {
        mcpTotals[server] = (mcpTotals[server] ?? 0) + data.calls
      }
    }
  }
  const sorted = Object.entries(mcpTotals).sort(([, a], [, b]) => b - a)
  if (sorted.length === 0) {
    return <Panel title="MCP Servers" color={PANEL_COLORS.mcp} width={pw}><Text dimColor>No MCP usage</Text></Panel>
  }
  const maxCalls = sorted[0]?.[1] ?? 0
  const nw = Math.max(6, pw - bw - 15)

  return (
    <Panel title="MCP Servers" color={PANEL_COLORS.mcp} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'calls'.padStart(6)}</Text>
      {sorted.slice(0, 8).map(([server, calls]) => (
        <Text key={server} wrap="truncate-end">
          <HBar value={calls} max={maxCalls} width={bw} />
          <Text> {fit(server, nw)}</Text>
          <Text>{String(calls).padStart(6)}</Text>
        </Text>
      ))}
    </Panel>
  )
}

function BashBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const bashTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cmd, data] of Object.entries(session.bashBreakdown)) {
        bashTotals[cmd] = (bashTotals[cmd] ?? 0) + data.calls
      }
    }
  }
  const sorted = Object.entries(bashTotals).sort(([, a], [, b]) => b - a)
  if (sorted.length === 0) {
    return <Panel title="Shell Commands" color={PANEL_COLORS.bash} width={pw}><Text dimColor>No shell commands</Text></Panel>
  }
  const maxCalls = sorted[0]?.[1] ?? 0
  const nw = Math.max(6, pw - bw - 15)

  return (
    <Panel title="Shell Commands" color={PANEL_COLORS.bash} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'calls'.padStart(7)}</Text>
      {sorted.slice(0, 10).map(([cmd, calls]) => (
        <Text key={cmd} wrap="truncate-end">
          <HBar value={calls} max={maxCalls} width={bw} />
          <Text> {fit(cmd, nw)}</Text>
          <Text>{String(calls).padStart(7)}</Text>
        </Text>
      ))}
    </Panel>
  )
}

function getProviderDisplayName(name: string): string {
  if (name === 'all') return 'All'
  const provider = providers.find(p => p.name === name)
  return provider?.displayName ?? name
}

function PeriodTabs({ active, providerName, showProvider }: {
  active: Period
  providerName?: string
  showProvider?: boolean
}) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        {PERIODS.map(p => (
          <Text key={p} bold={active === p} color={active === p ? ORANGE : DIM}>
            {active === p ? `[ ${PERIOD_LABELS[p]} ]` : `  ${PERIOD_LABELS[p]}  `}
          </Text>
        ))}
      </Box>
      {showProvider && providerName && (
        <Box>
          <Text color={DIM}>|  </Text>
          <Text color={ORANGE} bold>[p]</Text>
          <Text bold> {getProviderDisplayName(providerName)}</Text>
        </Box>
      )}
    </Box>
  )
}

function StatusBar({ width, showProvider }: { width: number; showProvider?: boolean }) {
  return (
    <Box borderStyle="round" borderColor={DIM} width={width} justifyContent="center" paddingX={1}>
      <Text>
        <Text color={ORANGE} bold>{'<'}</Text><Text color={ORANGE}>{'>'}</Text>
        <Text dimColor> switch   </Text>
        <Text color={ORANGE} bold>q</Text>
        <Text dimColor> quit   </Text>
        <Text color={ORANGE} bold>1</Text>
        <Text dimColor> today   </Text>
        <Text color={ORANGE} bold>2</Text>
        <Text dimColor> week   </Text>
        <Text color={ORANGE} bold>3</Text>
        <Text dimColor> 30 days   </Text>
        <Text color={ORANGE} bold>4</Text>
        <Text dimColor> month</Text>
        {showProvider && (
          <>
            <Text dimColor>   </Text>
            <Text color={ORANGE} bold>p</Text>
            <Text dimColor> provider</Text>
          </>
        )}
      </Text>
    </Box>
  )
}

function Row({ wide, width, children }: { wide: boolean; width: number; children: React.ReactNode }) {
  if (wide) return <Box width={width}>{children}</Box>
  return <>{children}</>
}

function DashboardContent({ projects, period, columns }: { projects: ProjectSummary[]; period: Period; columns?: number }) {
  const { dashWidth, wide, halfWidth, barWidth } = getLayout(columns)

  if (projects.length === 0) {
    return (
      <Panel title="CodeBurn" color={ORANGE} width={dashWidth}>
        <Text dimColor>No usage data found for {PERIOD_LABELS[period]}.</Text>
      </Panel>
    )
  }

  const pw = wide ? halfWidth : dashWidth

  return (
    <Box flexDirection="column" width={dashWidth}>
      <Overview projects={projects} label={PERIOD_LABELS[period]} width={dashWidth} />

      <Row wide={wide} width={dashWidth}>
        <DailyActivity projects={projects} days={period === 'month' || period === '30days' ? 31 : 14} pw={pw} bw={barWidth} />
        <ProjectBreakdown projects={projects} pw={pw} bw={barWidth} />
      </Row>

      <Row wide={wide} width={dashWidth}>
        <ActivityBreakdown projects={projects} pw={pw} bw={barWidth} />
        <ModelBreakdown projects={projects} pw={pw} bw={barWidth} />
      </Row>

      <Row wide={wide} width={dashWidth}>
        <ToolBreakdown projects={projects} pw={pw} bw={barWidth} />
        <BashBreakdown projects={projects} pw={pw} bw={barWidth} />
      </Row>

      <McpBreakdown projects={projects} pw={dashWidth} bw={barWidth} />
    </Box>
  )
}

function InteractiveDashboard({ initialProjects, initialPeriod, initialProvider }: {
  initialProjects: ProjectSummary[]
  initialPeriod: Period
  initialProvider: string
}) {
  const { exit } = useApp()
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects)
  const [loading, setLoading] = useState(false)
  const [activeProvider, setActiveProvider] = useState(initialProvider)
  const [detectedProviders, setDetectedProviders] = useState<string[]>([])
  const { columns } = useWindowSize()
  const { dashWidth } = getLayout(columns)
  const multipleProviders = detectedProviders.length > 1

  useEffect(() => {
    let cancelled = false
    async function detect() {
      const found: string[] = []
      for (const p of providers) {
        const sessions = await p.discoverSessions()
        if (sessions.length > 0) found.push(p.name)
      }
      if (!cancelled) {
        setDetectedProviders(found)
        if (found.length > 1) {
          const range = getDateRange(period)
          for (const name of found) parseAllSessions(range, name).catch(() => {})
        }
      }
    }
    detect()
    return () => { cancelled = true }
  }, [])

  const reloadData = useCallback(async (p: Period, prov: string) => {
    setLoading(true)
    const range = getDateRange(p)
    const data = await parseAllSessions(range, prov)
    setProjects(data)
    setLoading(false)
  }, [])

  const switchPeriod = useCallback(async (newPeriod: Period) => {
    if (newPeriod === period) return
    setPeriod(newPeriod)
    await reloadData(newPeriod, activeProvider)
  }, [period, activeProvider, reloadData])

  useInput((input, key) => {
    if (input === 'q') {
      exit()
      return
    }

    if (input === 'p' && multipleProviders) {
      const options = ['all', ...detectedProviders]
      const idx = options.indexOf(activeProvider)
      const next = options[(idx + 1) % options.length]
      setActiveProvider(next)
      reloadData(period, next)
      return
    }

    const idx = PERIODS.indexOf(period)
    if (key.leftArrow) {
      switchPeriod(PERIODS[(idx - 1 + PERIODS.length) % PERIODS.length])
    } else if (key.rightArrow || key.tab) {
      switchPeriod(PERIODS[(idx + 1) % PERIODS.length])
    } else if (input === '1') switchPeriod('today')
    else if (input === '2') switchPeriod('week')
    else if (input === '3') switchPeriod('30days')
    else if (input === '4') switchPeriod('month')
  })

  if (loading) {
    return (
      <Box flexDirection="column" width={dashWidth}>
        <PeriodTabs active={period} providerName={activeProvider} showProvider={multipleProviders} />
        <Panel title="CodeBurn" color={ORANGE} width={dashWidth}>
          <Text dimColor>Loading {PERIOD_LABELS[period]}...</Text>
        </Panel>
        <StatusBar width={dashWidth} showProvider={multipleProviders} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={dashWidth}>
      <PeriodTabs active={period} providerName={activeProvider} showProvider={multipleProviders} />
      <DashboardContent projects={projects} period={period} columns={columns} />
      <StatusBar width={dashWidth} showProvider={multipleProviders} />
    </Box>
  )
}

function StaticDashboard({ projects, period }: { projects: ProjectSummary[]; period: Period }) {
  const { columns } = useWindowSize()
  const { dashWidth } = getLayout(columns)
  return (
    <Box flexDirection="column" width={dashWidth}>
      <PeriodTabs active={period} />
      <DashboardContent projects={projects} period={period} columns={columns} />
    </Box>
  )
}

export async function renderDashboard(period: Period = 'week', provider: string = 'all'): Promise<void> {
  await loadPricing()
  const range = getDateRange(period)
  const projects = await parseAllSessions(range, provider)

  const isTTY = process.stdin.isTTY && process.stdout.isTTY

  if (isTTY) {
    const { waitUntilExit } = render(
      <InteractiveDashboard initialProjects={projects} initialPeriod={period} initialProvider={provider} />
    )
    await waitUntilExit()
  } else {
    const { unmount } = render(
      <StaticDashboard projects={projects} period={period} />,
      { patchConsole: false }
    )
    unmount()
  }
}
