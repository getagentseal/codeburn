import { homedir } from 'os'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { render, Box, Text, useInput, useApp, useWindowSize } from 'ink'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { formatCost, formatTokens } from './format.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { parseAllSessions, filterProjectsByName } from './parser.js'
import { loadPricing } from './models.js'
import { getAllProviders } from './providers/index.js'
import { scanAndDetect, type WasteFinding, type WasteAction, type OptimizeResult } from './optimize.js'
import { estimateContextBudget, discoverProjectCwd, type ContextBudget } from './context-budget.js'
import { dateKey } from './day-aggregator.js'
import { CompareView } from './compare.js'
import { getPlanUsageOrNull, type PlanUsage } from './plan-usage.js'
import { planDisplayName } from './plans.js'
import { getDateRange, PERIODS, PERIOD_LABELS, type Period } from './cli-date.js'
import { join } from 'path'
import { patchStdoutForWindows } from './ink-win.js'

type View = 'dashboard' | 'optimize' | 'compare'

const MIN_WIDE = 90
const ORANGE = '#FF8C42'
const DIM = '#555555'
const GOLD = '#FFD700'
const PLAN_BAR_WIDTH = 10

const LANG_DISPLAY_NAMES: Record<string, string> = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python',
  rust: 'Rust', go: 'Go', java: 'Java', cpp: 'C++', c: 'C', csharp: 'C#',
  ruby: 'Ruby', php: 'PHP', swift: 'Swift', kotlin: 'Kotlin',
  html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yaml: 'YAML',
  sql: 'SQL', shell: 'Shell', shellscript: 'Shell Script', bash: 'Bash',
  typescriptreact: 'TSX', javascriptreact: 'JSX',
  markdown: 'Markdown', dockerfile: 'Dockerfile', toml: 'TOML',
}

const PANEL_COLORS = {
  overview: '#FF8C42',
  daily: '#5B9EF5',
  project: '#5BF5A0',
  sessions: '#FF6B6B',
  model: '#E05BF5',
  activity: '#F5C85B',
  tools: '#5BF5E0',
  mcp: '#F55BE0',
  bash: '#F5A05B',
}

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#FF8C42',
  codex: '#5BF5A0',
  cursor: '#00B4D8',
  opencode: '#A78BFA',
  pi: '#F472B6',
  all: '#FF8C42',
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

const IMPACT_PANEL_COLORS: Record<string, string> = { high: '#F55B5B', medium: ORANGE, low: DIM }

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

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

function getPeriodRange(period: Period): { start: Date; end: Date } {
  return getDateRange(period).range
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

const PANEL_CHROME = 4

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

function renderPlanBar(percentUsed: number, width: number): string {
  if (percentUsed <= 100) {
    const capped = Math.max(0, percentUsed)
    const filled = Math.round((capped / 100) * width)
    return `${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
  }
  const factor = percentUsed / 100
  const chevrons = Math.min(4, Math.max(1, Math.floor(Math.log10(factor)) + 1))
  return `${'▓'.repeat(width)}${'▶'.repeat(chevrons)}`
}

function Overview({ projects, label, width, planUsage }: { projects: ProjectSummary[]; label: string; width: number; planUsage?: PlanUsage }) {
  const totalCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const allSessions = projects.flatMap(p => p.sessions)
  const totalInput = allSessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = allSessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = allSessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = allSessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  const allInputTokens = totalInput + totalCacheRead + totalCacheWrite
  const cacheHit = allInputTokens > 0
    ? (totalCacheRead / allInputTokens) * 100 : 0
  const planLabel = planUsage ? `${planDisplayName(planUsage.plan.id)}: ${formatCost(planUsage.spentApiEquivalentUsd)} API-equivalent vs ${formatCost(planUsage.budgetUsd)} plan` : ''
  const planPct = planUsage ? `${planUsage.percentUsed.toFixed(1)}%` : ''
  const planColor = planUsage
    ? planUsage.status === 'over'
      ? '#F55B5B'
      : planUsage.status === 'near'
        ? ORANGE
        : '#5BF58C'
    : DIM

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
        <Text bold>{cacheHit.toFixed(1)}%</Text>
        <Text dimColor> cache hit</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {formatTokens(totalInput)} in   {formatTokens(totalOutput)} out   {formatTokens(totalCacheRead)} cached   {formatTokens(totalCacheWrite)} written
      </Text>
      {planUsage && (
        <>
          <Text wrap="truncate-end">
            <Text color={planColor}>{planLabel}</Text>
            <Text>  </Text>
            <Text color={planColor}>{renderPlanBar(planUsage.percentUsed, PLAN_BAR_WIDTH)}</Text>
            <Text> </Text>
            <Text bold color={planColor}>{planPct}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {planUsage.status === 'under'
              ? `Well within plan. Projected month: ${formatCost(planUsage.projectedMonthUsd)} (reset in ${planUsage.daysUntilReset} days).`
              : planUsage.status === 'near'
                ? `Approaching plan limit. Projected month: ${formatCost(planUsage.projectedMonthUsd)} (reset in ${planUsage.daysUntilReset} days).`
                : `${(planUsage.spentApiEquivalentUsd / Math.max(planUsage.budgetUsd, 1)).toFixed(1)}x your subscription value. Projected month: ${formatCost(planUsage.projectedMonthUsd)} (reset in ${planUsage.daysUntilReset} days).`}
          </Text>
        </>
      )}
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
        const day = dateKey(turn.timestamp)
        dailyCosts[day] = (dailyCosts[day] ?? 0) + turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        dailyCalls[day] = (dailyCalls[day] ?? 0) + turn.assistantCalls.length
      }
    }
  }
  const sortedDays = days !== undefined ? Object.keys(dailyCosts).sort().slice(-days) : Object.keys(dailyCosts).sort()
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
  if (path.startsWith(_homeEncoded.replace(/^-/, ''))) {
    path = path.slice(_homeEncoded.replace(/^-/, '').length).replace(/^-/, '')
  }
  path = path.replace(/^private-tmp-[^-]+-[^-]+-/, '').replace(/^private-tmp-/, '').replace(/^tmp-/, '')
  if (!path) return 'home'
  const parts = path.split('-').filter(Boolean)
  if (parts.length <= 3) return parts.join('/')
  return parts.slice(-3).join('/')
}

const PROJECT_COL_AVG = 7
const PROJECT_COL_BASE_WIDTH = 30
const PROJECT_COL_WITH_OVERHEAD_WIDTH = 40

function ProjectBreakdown({ projects, pw, bw, budgets }: { projects: ProjectSummary[]; pw: number; bw: number; budgets?: Map<string, ContextBudget> }) {
  const maxCost = Math.max(...projects.map(p => p.totalCostUSD))
  const hasBudgets = budgets && budgets.size > 0
  const nw = Math.max(8, pw - bw - (hasBudgets ? PROJECT_COL_WITH_OVERHEAD_WIDTH : PROJECT_COL_BASE_WIDTH))
  return (
    <Panel title="By Project" color={PANEL_COLORS.project} width={pw}>
      <Text dimColor wrap="truncate-end">
        {''.padEnd(bw + 1 + nw)}{'cost'.padStart(8)}{'avg/s'.padStart(PROJECT_COL_AVG)}{'sess'.padStart(6)}{hasBudgets ? 'overhead'.padStart(10) : ''}
      </Text>
      {projects.slice(0, 8).map((project, i) => {
        const budget = budgets?.get(project.project)
        const avgCost = project.sessions.length > 0
          ? formatCost(project.totalCostUSD / project.sessions.length)
          : '-'
        return (
          <Text key={`${project.project}-${i}`} wrap="truncate-end">
            <HBar value={project.totalCostUSD} max={maxCost} width={bw} />
            <Text dimColor> {fit(shortProject(project.project), nw)}</Text>
            <Text color={GOLD}>{formatCost(project.totalCostUSD).padStart(8)}</Text>
            <Text color={GOLD}>{avgCost.padStart(PROJECT_COL_AVG)}</Text>
            <Text>{String(project.sessions.length).padStart(6)}</Text>
            {hasBudgets && <Text color="#7B9EF5">{(budget ? formatTokens(budget.total) : '-').padStart(10)}</Text>}
          </Text>
        )
      })}
    </Panel>
  )
}

const MODEL_COL_COST = 8
const MODEL_COL_CACHE = 7
const MODEL_COL_CALLS = 7
const MODEL_COL_ONESHOT = 7
const MODEL_NAME_WIDTH = 14
const MIN_EDIT_TURNS_FOR_RATE = 5

function ModelBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const modelTotals: Record<string, { calls: number; costUSD: number; freshInput: number; cacheRead: number; cacheWrite: number }> = {}
  const modelEfficiency = aggregateModelEfficiency(projects)
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) modelTotals[model] = { calls: 0, costUSD: 0, freshInput: 0, cacheRead: 0, cacheWrite: 0 }
        modelTotals[model].calls += data.calls
        modelTotals[model].costUSD += data.costUSD
        modelTotals[model].freshInput += data.tokens.inputTokens
        modelTotals[model].cacheRead += data.tokens.cacheReadInputTokens
        modelTotals[model].cacheWrite += data.tokens.cacheCreationInputTokens
      }
    }
  }
  const sorted = Object.entries(modelTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD)
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0

  return (
    <Panel title="By Model" color={PANEL_COLORS.model} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + MODEL_NAME_WIDTH)}{'cost'.padStart(MODEL_COL_COST)}{'cache'.padStart(MODEL_COL_CACHE)}{'calls'.padStart(MODEL_COL_CALLS)}{'1-shot'.padStart(MODEL_COL_ONESHOT)}</Text>
      {sorted.map(([model, data], i) => {
        const totalInput = data.freshInput + data.cacheRead + data.cacheWrite
        const cacheHit = totalInput > 0 ? (data.cacheRead / totalInput) * 100 : 0
        const cacheLabel = totalInput > 0 ? `${cacheHit.toFixed(1)}%` : '-'
        const efficiency = modelEfficiency.get(model)
        const oneShotLabel = efficiency && efficiency.editTurns >= MIN_EDIT_TURNS_FOR_RATE && efficiency.oneShotRate !== null
          ? `${efficiency.oneShotRate.toFixed(1)}%`
          : '-'
        return (
          <Text key={`${model}-${i}`} wrap="truncate-end">
            <HBar value={data.costUSD} max={maxCost} width={bw} />
            <Text> {fit(model, MODEL_NAME_WIDTH)}</Text>
            <Text color={GOLD}>{formatCost(data.costUSD).padStart(MODEL_COL_COST)}</Text>
            <Text>{cacheLabel.padStart(MODEL_COL_CACHE)}</Text>
            <Text>{String(data.calls).padStart(MODEL_COL_CALLS)}</Text>
            <Text>{oneShotLabel.padStart(MODEL_COL_ONESHOT)}</Text>
          </Text>
        )
      })}
    </Panel>
  )
}

const SKILL_SUB_ROWS_LIMIT = 5

function ActivityBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const categoryTotals: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }> = {}
  const skillTotals: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, data] of Object.entries(session.categoryBreakdown)) {
        if (!categoryTotals[cat]) categoryTotals[cat] = { turns: 0, costUSD: 0, editTurns: 0, oneShotTurns: 0 }
        categoryTotals[cat].turns += data.turns
        categoryTotals[cat].costUSD += data.costUSD
        categoryTotals[cat].editTurns += data.editTurns
        categoryTotals[cat].oneShotTurns += data.oneShotTurns
      }
      for (const [skill, data] of Object.entries(session.skillBreakdown ?? {})) {
        if (!skillTotals[skill]) skillTotals[skill] = { turns: 0, costUSD: 0, editTurns: 0, oneShotTurns: 0 }
        skillTotals[skill].turns += data.turns
        skillTotals[skill].costUSD += data.costUSD
        skillTotals[skill].editTurns += data.editTurns
        skillTotals[skill].oneShotTurns += data.oneShotTurns
      }
    }
  }
  const sorted = Object.entries(categoryTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD)
  const sortedSkills = Object.entries(skillTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD).slice(0, SKILL_SUB_ROWS_LIMIT)
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0
  return (
    <Panel title="By Activity" color={PANEL_COLORS.activity} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 14)}{'cost'.padStart(8)}{'turns'.padStart(6)}{'1-shot'.padStart(7)}</Text>
      {sorted.flatMap(([cat, data]) => {
        const oneShotPct = data.editTurns > 0 ? Math.round((data.oneShotTurns / data.editTurns) * 100) + '%' : '-'
        const rows = [
          <Text key={cat} wrap="truncate-end">
            <HBar value={data.costUSD} max={maxCost} width={bw} />
            <Text color={CATEGORY_COLORS[cat as TaskCategory] ?? '#666666'}> {fit(CATEGORY_LABELS[cat as TaskCategory] ?? cat, 13)}</Text>
            <Text color={GOLD}>{formatCost(data.costUSD).padStart(8)}</Text>
            <Text>{String(data.turns).padStart(6)}</Text>
            <Text color={data.editTurns === 0 ? DIM : oneShotPct === '100%' ? '#5BF58C' : ORANGE}>{String(oneShotPct).padStart(7)}</Text>
          </Text>,
        ]
        if (cat === 'general' && sortedSkills.length > 0) {
          for (const [skill, sd] of sortedSkills) {
            const subPct = sd.editTurns > 0 ? Math.round((sd.oneShotTurns / sd.editTurns) * 100) + '%' : '-'
            rows.push(
              <Text key={`${cat}:${skill}`} wrap="truncate-end" dimColor>
                <HBar value={sd.costUSD} max={maxCost} width={bw} />
                <Text> {fit(`  /${skill}`, 13)}</Text>
                <Text>{formatCost(sd.costUSD).padStart(8)}</Text>
                <Text>{String(sd.turns).padStart(6)}</Text>
                <Text>{String(subPct).padStart(7)}</Text>
              </Text>,
            )
          }
        }
        return rows
      })}
    </Panel>
  )
}

function ToolBreakdown({ projects, pw, bw, title, filterPrefix }: { projects: ProjectSummary[]; pw: number; bw: number; title?: string; filterPrefix?: string }) {
  const toolTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, data] of Object.entries(session.toolBreakdown)) {
        if (filterPrefix) { if (!tool.startsWith(filterPrefix)) continue } else { if (tool.startsWith('lang:')) continue }
        toolTotals[tool] = (toolTotals[tool] ?? 0) + data.calls
      }
    }
  }
  const sorted = Object.entries(toolTotals).sort(([, a], [, b]) => b - a)
  const maxCalls = sorted[0]?.[1] ?? 0
  const nw = Math.max(6, pw - bw - 15)
  return (
    <Panel title={title ?? 'Core Tools'} color={PANEL_COLORS.tools} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'calls'.padStart(7)}</Text>
      {sorted.slice(0, 10).map(([tool, calls]) => {
        const raw = filterPrefix ? tool.slice(filterPrefix.length) : tool
        const display = filterPrefix ? (LANG_DISPLAY_NAMES[raw] ?? raw) : raw
        return (
          <Text key={tool} wrap="truncate-end">
            <HBar value={calls} max={maxCalls} width={bw} />
            <Text> {fit(display, nw)}</Text>
            <Text>{String(calls).padStart(7)}</Text>
          </Text>
        )
      })}
    </Panel>
  )
}

const TOP_SESSIONS_DATE_LEN = 10
const TOP_SESSIONS_COST_COL = 8
const TOP_SESSIONS_CALLS_COL = 6

function TopSessions({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const allSessions = projects.flatMap(p =>
    p.sessions.map(s => ({ ...s, projectName: p.project }))
  )
  const top = [...allSessions].sort((a, b) => b.totalCostUSD - a.totalCostUSD).slice(0, 5)

  if (top.length === 0) {
    return <Panel title="Top Sessions" color={PANEL_COLORS.sessions} width={pw}><Text dimColor>No sessions</Text></Panel>
  }

  const maxCost = top[0].totalCostUSD
  const nw = Math.max(8, pw - bw - TOP_SESSIONS_COST_COL - TOP_SESSIONS_CALLS_COL - 1 - PANEL_CHROME)

  return (
    <Panel title="Top Sessions" color={PANEL_COLORS.sessions} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'cost'.padStart(TOP_SESSIONS_COST_COL)}{'calls'.padStart(TOP_SESSIONS_CALLS_COL)}</Text>
      {top.map((session, i) => {
        const date = session.firstTimestamp
          ? session.firstTimestamp.slice(0, TOP_SESSIONS_DATE_LEN)
          : '----------'
        const label = `${date} ${shortProject(session.projectName)}`
        return (
          <Text key={`${session.sessionId}-${i}`} wrap="truncate-end">
            <HBar value={session.totalCostUSD} max={maxCost} width={bw} />
            <Text dimColor> {fit(label, nw - 1)}</Text>
            <Text color={GOLD}>{formatCost(session.totalCostUSD).padStart(TOP_SESSIONS_COST_COL)}</Text>
            <Text>{String(session.apiCalls).padStart(TOP_SESSIONS_CALLS_COL)}</Text>
          </Text>
        )
      })}
    </Panel>
  )
}

function McpBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const mcpTotals: Record<string, number> = {}
  for (const project of projects) { for (const session of project.sessions) { for (const [server, data] of Object.entries(session.mcpBreakdown)) { mcpTotals[server] = (mcpTotals[server] ?? 0) + data.calls } } }
  const sorted = Object.entries(mcpTotals).sort(([, a], [, b]) => b - a)
  if (sorted.length === 0) return <Panel title="MCP Servers" color={PANEL_COLORS.mcp} width={pw}><Text dimColor>No MCP usage</Text></Panel>
  const maxCalls = sorted[0]?.[1] ?? 0
  const nw = Math.max(6, pw - bw - 15)
  return (
    <Panel title="MCP Servers" color={PANEL_COLORS.mcp} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'calls'.padStart(6)}</Text>
      {sorted.slice(0, 8).map(([server, calls]) => (
        <Text key={server} wrap="truncate-end"><HBar value={calls} max={maxCalls} width={bw} /><Text> {fit(server, nw)}</Text><Text>{String(calls).padStart(6)}</Text></Text>
      ))}
    </Panel>
  )
}

function BashBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const bashTotals: Record<string, number> = {}
  for (const project of projects) { for (const session of project.sessions) { for (const [cmd, data] of Object.entries(session.bashBreakdown)) { bashTotals[cmd] = (bashTotals[cmd] ?? 0) + data.calls } } }
  const sorted = Object.entries(bashTotals).sort(([, a], [, b]) => b - a)
  if (sorted.length === 0) return <Panel title="Shell Commands" color={PANEL_COLORS.bash} width={pw}><Text dimColor>No shell commands</Text></Panel>
  const maxCalls = sorted[0]?.[1] ?? 0
  const nw = Math.max(6, pw - bw - 15)
  return (
    <Panel title="Shell Commands" color={PANEL_COLORS.bash} width={pw}>
      <Text dimColor wrap="truncate-end">{''.padEnd(bw + 1 + nw)}{'calls'.padStart(7)}</Text>
      {sorted.slice(0, 10).map(([cmd, calls]) => (
        <Text key={cmd} wrap="truncate-end"><HBar value={calls} max={maxCalls} width={bw} /><Text> {fit(cmd, nw)}</Text><Text>{String(calls).padStart(7)}</Text></Text>
      ))}
    </Panel>
  )
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  all: 'All',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
}
function getProviderDisplayName(name: string): string { return PROVIDER_DISPLAY_NAMES[name] ?? name }

function PeriodTabs({ active, providerName, showProvider }: { active: Period; providerName?: string; showProvider?: boolean }) {
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
        <Box><Text color={DIM}>|  </Text><Text color={ORANGE} bold>[p]</Text><Text bold color={PROVIDER_COLORS[providerName] ?? ORANGE}> {getProviderDisplayName(providerName)}</Text></Box>
      )}
    </Box>
  )
}

function FindingAction({ action }: { action: WasteAction }) {
  const lines = action.type === 'file-content' ? action.content.split('\n') : action.type === 'command' ? action.text.split('\n') : [action.text]
  return (<><Text dimColor>{action.label}</Text>{lines.map((line, i) => <Text key={i} color="#5BF5E0">  {line}</Text>)}</>)
}

function FindingPanel({ index, finding, costRate, width }: { index: number; finding: WasteFinding; costRate: number; width: number }) {
  const costSaved = finding.tokensSaved * costRate
  const color = IMPACT_PANEL_COLORS[finding.impact] ?? DIM
  const label = finding.impact.charAt(0).toUpperCase() + finding.impact.slice(1)
  const trendBadge = finding.trend === 'improving' ? ' improving \u2193' : ''
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width}>
      <Text wrap="truncate-end">
        <Text bold>{index}. {finding.title}</Text>
        <Text>  </Text>
        <Text color={color}>{label}</Text>
        {trendBadge && <Text color="#5BF5A0">{trendBadge}</Text>}
      </Text>
      <Text dimColor wrap="wrap">{finding.explanation}</Text>
      <Text color={GOLD}>Savings: ~{formatTokens(finding.tokensSaved)} tokens (~{formatCost(costSaved)})</Text>
      <Text> </Text>
      <FindingAction action={finding.fix} />
    </Box>
  )
}

const GRADE_COLORS: Record<string, string> = { A: '#5BF5A0', B: '#5BF5A0', C: GOLD, D: ORANGE, F: '#F55B5B' }

function OptimizeView({ findings, costRate, projects, label, width, healthScore, healthGrade }: { findings: WasteFinding[]; costRate: number; projects: ProjectSummary[]; label: string; width: number; healthScore: number; healthGrade: string }) {
  const periodCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalTokens = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const totalCost = totalTokens * costRate
  const pctRaw = periodCost > 0 ? (totalCost / periodCost) * 100 : 0
  const pct = pctRaw >= 1 ? pctRaw.toFixed(0) : pctRaw.toFixed(1)
  const gradeColor = GRADE_COLORS[healthGrade] ?? DIM
  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1} width={width}>
        <Text wrap="truncate-end">
          <Text bold color={ORANGE}>CodeBurn Optimize</Text>
          <Text dimColor>  {label}   Setup: </Text>
          <Text bold color={gradeColor}>{healthGrade}</Text>
          <Text dimColor> ({healthScore}/100)</Text>
        </Text>
        <Text color="#5BF5A0" wrap="truncate-end">Savings: ~{formatTokens(totalTokens)} tokens (~{formatCost(totalCost)}, ~{pct}% of spend)</Text>
      </Box>
      {findings.map((f, i) => <FindingPanel key={i} index={i + 1} finding={f} costRate={costRate} width={width} />)}
      <Box paddingX={1} width={width}><Text dimColor>Token estimates are approximate.</Text></Box>
    </Box>
  )
}

function StatusBar({ width, showProvider, view, findingCount, optimizeAvailable, compareAvailable }: { width: number; showProvider?: boolean; view?: View; findingCount?: number; optimizeAvailable?: boolean; compareAvailable?: boolean }) {
  const isOptimize = view === 'optimize'
  return (
    <Box borderStyle="round" borderColor={DIM} width={width} justifyContent="center" paddingX={1}>
      <Text>
        {isOptimize
          ? <><Text color={ORANGE} bold>b</Text><Text dimColor> back   </Text></>
          : <><Text color={ORANGE} bold>{'<'}</Text><Text color={ORANGE}>{'>'}</Text><Text dimColor> switch   </Text></>}
        <Text color={ORANGE} bold>q</Text><Text dimColor> quit   </Text>
        <Text color={ORANGE} bold>1</Text><Text dimColor> today   </Text>
        <Text color={ORANGE} bold>2</Text><Text dimColor> week   </Text>
        <Text color={ORANGE} bold>3</Text><Text dimColor> 30 days   </Text>
        <Text color={ORANGE} bold>4</Text><Text dimColor> month   </Text>
        <Text color={ORANGE} bold>5</Text><Text dimColor> 6 months</Text>
        {!isOptimize && optimizeAvailable && findingCount != null && findingCount > 0 && (
          <><Text dimColor>   </Text><Text color={ORANGE} bold>o</Text><Text dimColor> optimize</Text><Text color="#F55B5B"> ({findingCount})</Text></>
        )}
        {!isOptimize && compareAvailable && (
          <><Text dimColor>   </Text><Text color={ORANGE} bold>c</Text><Text dimColor> compare</Text></>
        )}
        {showProvider && (<><Text dimColor>   </Text><Text color={ORANGE} bold>p</Text><Text dimColor> provider</Text></>)}
      </Text>
    </Box>
  )
}

function Row({ wide, width, children }: { wide: boolean; width: number; children: React.ReactNode }) {
  if (wide) return <Box width={width}>{children}</Box>
  return <>{children}</>
}

function DashboardContent({ projects, period, columns, activeProvider, budgets, planUsage }: { projects: ProjectSummary[]; period: Period; columns?: number; activeProvider?: string; budgets?: Map<string, ContextBudget>; planUsage?: PlanUsage }) {
  const { dashWidth, wide, halfWidth, barWidth } = getLayout(columns)
  const isCursor = activeProvider === 'cursor'
  if (projects.length === 0) return <Panel title="CodeBurn" color={ORANGE} width={dashWidth}><Text dimColor>No usage data found for {PERIOD_LABELS[period]}.</Text></Panel>
  const pw = wide ? halfWidth : dashWidth
  const days = period === 'all' ? undefined : (period === 'month' || period === '30days' ? 31 : 14)
  return (
    <Box flexDirection="column" width={dashWidth}>
      <Overview projects={projects} label={PERIOD_LABELS[period]} width={dashWidth} planUsage={planUsage} />
      <Row wide={wide} width={dashWidth}><DailyActivity projects={projects} days={days} pw={pw} bw={barWidth} /><ProjectBreakdown projects={projects} pw={pw} bw={barWidth} budgets={budgets} /></Row>
      <TopSessions projects={projects} pw={dashWidth} bw={barWidth} />
      <Row wide={wide} width={dashWidth}><ActivityBreakdown projects={projects} pw={pw} bw={barWidth} /><ModelBreakdown projects={projects} pw={pw} bw={barWidth} /></Row>
      {isCursor ? (
        <ToolBreakdown projects={projects} pw={dashWidth} bw={barWidth} title="Languages" filterPrefix="lang:" />
      ) : (
        <><Row wide={wide} width={dashWidth}><ToolBreakdown projects={projects} pw={pw} bw={barWidth} /><BashBreakdown projects={projects} pw={pw} bw={barWidth} /></Row><McpBreakdown projects={projects} pw={dashWidth} bw={barWidth} /></>
      )}
    </Box>
  )
}

function InteractiveDashboard({ initialProjects, initialPeriod, initialProvider, initialPlanUsage, refreshSeconds, projectFilter, excludeFilter }: {
  initialProjects: ProjectSummary[]
  initialPeriod: Period
  initialProvider: string
  initialPlanUsage?: PlanUsage
  refreshSeconds?: number
  projectFilter?: string[]
  excludeFilter?: string[]
}) {
  const { exit } = useApp()
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects)
  const [loading, setLoading] = useState(false)
  const [activeProvider, setActiveProvider] = useState(initialProvider)
  const [detectedProviders, setDetectedProviders] = useState<string[]>([])
  const [view, setView] = useState<View>('dashboard')
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null)
  const [projectBudgets, setProjectBudgets] = useState<Map<string, ContextBudget>>(new Map())
  const [planUsage, setPlanUsage] = useState<PlanUsage | undefined>(initialPlanUsage)
  const { columns } = useWindowSize()
  const { dashWidth } = getLayout(columns)
  const multipleProviders = detectedProviders.length > 1
  const optimizeAvailable = activeProvider === 'all' || activeProvider === 'claude'
  const modelCount = new Set(
    projects.flatMap(p => p.sessions.flatMap(s => Object.keys(s.modelBreakdown)))
  ).size
  const compareAvailable = modelCount >= 2
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reloadGenerationRef = useRef(0)
  const findingCount = optimizeResult?.findings.length ?? 0

  useEffect(() => {
    let cancelled = false
    async function detect() {
      const found: string[] = []
      for (const p of await getAllProviders()) { const s = await p.discoverSessions(); if (s.length > 0) found.push(p.name) }
      if (!cancelled) setDetectedProviders(found)
    }
    detect()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadBudgets() {
      const claudeDir = join(homedir(), '.claude', 'projects')
      const budgets = new Map<string, ContextBudget>()
      for (const project of projects.slice(0, 8)) {
        if (cancelled) return
        const cwd = await discoverProjectCwd(join(claudeDir, project.project))
        if (!cwd) continue
        budgets.set(project.project, await estimateContextBudget(cwd))
      }
      if (!cancelled) setProjectBudgets(budgets)
    }
    loadBudgets()
    return () => { cancelled = true }
  }, [projects])

  useEffect(() => {
    if (!optimizeAvailable) { setOptimizeResult(null); return }
    let cancelled = false
    async function scan() {
      if (projects.length === 0) { setOptimizeResult(null); return }
      const result = await scanAndDetect(projects, getPeriodRange(period))
      if (!cancelled) setOptimizeResult(result)
    }
    scan()
    return () => { cancelled = true }
  }, [projects, period, optimizeAvailable])

  const reloadData = useCallback(async (p: Period, prov: string) => {
    const generation = ++reloadGenerationRef.current
    setLoading(true)
    setOptimizeResult(null)
    try {
      const range = getPeriodRange(p)
      const data = await parseAllSessions(range, prov)
      if (reloadGenerationRef.current !== generation) return

      const filteredProjects = filterProjectsByName(data, projectFilter, excludeFilter)
      if (reloadGenerationRef.current !== generation) return

      setProjects(filteredProjects)
      const usage = await getPlanUsageOrNull()
      if (reloadGenerationRef.current !== generation) return
      setPlanUsage(usage ?? undefined)
    } catch (error) {
      console.error(error)
    } finally {
      if (reloadGenerationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [projectFilter, excludeFilter])

  useEffect(() => {
    if (!refreshSeconds || refreshSeconds <= 0) return
    const id = setInterval(() => { reloadData(period, activeProvider) }, refreshSeconds * 1000)
    return () => clearInterval(id)
  }, [refreshSeconds, period, activeProvider, reloadData])

  const switchPeriod = useCallback((np: Period) => {
    if (np === period) return
    setPeriod(np)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { reloadData(np, activeProvider) }, 600)
  }, [period, activeProvider, reloadData])

  const switchPeriodImmediate = useCallback(async (np: Period) => {
    if (np === period) return
    setPeriod(np)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    await reloadData(np, activeProvider)
  }, [period, activeProvider, reloadData])

  useInput((input, key) => {
    if (input === 'q') { exit(); return }
    if (input === 'o' && findingCount > 0 && view === 'dashboard' && optimizeAvailable) { setView('optimize'); return }
    if ((input === 'b' || key.escape) && view === 'optimize') { setView('dashboard'); return }
    if (input === 'c' && compareAvailable && view === 'dashboard') { setView('compare'); return }
    if (input === 'p' && multipleProviders && view !== 'compare') {
      const opts = ['all', ...detectedProviders]; const next = opts[(opts.indexOf(activeProvider) + 1) % opts.length]
      setActiveProvider(next); setView('dashboard')
      if (debounceRef.current) clearTimeout(debounceRef.current)
      reloadData(period, next); return
    }
    const idx = PERIODS.indexOf(period)
    if (key.leftArrow) switchPeriod(PERIODS[(idx - 1 + PERIODS.length) % PERIODS.length]!)
    else if (key.rightArrow || key.tab) switchPeriod(PERIODS[(idx + 1) % PERIODS.length]!)
    else if (input === '1') switchPeriodImmediate('today')
    else if (input === '2') switchPeriodImmediate('week')
    else if (input === '3') switchPeriodImmediate('30days')
    else if (input === '4') switchPeriodImmediate('month')
    else if (input === '5') switchPeriodImmediate('all')
  })

  if (loading) {
    return (
      <Box flexDirection="column" width={dashWidth}>
        <PeriodTabs active={period} providerName={activeProvider} showProvider={view !== 'compare' && multipleProviders} />
        {view === 'compare'
          ? <Box flexDirection="column" paddingX={2} paddingY={1}>
              <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
                <Text bold color={ORANGE}>Model Comparison</Text>
                <Text> </Text>
                <Text dimColor>Loading {PERIOD_LABELS[period]} model data...</Text>
              </Box>
            </Box>
          : <Panel title="CodeBurn" color={ORANGE} width={dashWidth}><Text dimColor>Loading {PERIOD_LABELS[period]}...</Text></Panel>}
        {view !== 'compare' && <StatusBar width={dashWidth} showProvider={multipleProviders} view={view} findingCount={0} optimizeAvailable={false} compareAvailable={false} />}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={dashWidth}>
      <PeriodTabs active={period} providerName={activeProvider} showProvider={multipleProviders && view !== 'compare'} />
      {view === 'compare'
        ? <CompareView projects={projects} onBack={() => setView('dashboard')} />
        : view === 'optimize' && optimizeResult
          ? <OptimizeView findings={optimizeResult.findings} costRate={optimizeResult.costRate} projects={projects} label={PERIOD_LABELS[period]} width={dashWidth} healthScore={optimizeResult.healthScore} healthGrade={optimizeResult.healthGrade} />
          : <DashboardContent projects={projects} period={period} columns={columns} activeProvider={activeProvider} budgets={projectBudgets} planUsage={planUsage} />}
      {view !== 'compare' && <StatusBar width={dashWidth} showProvider={multipleProviders} view={view} findingCount={findingCount} optimizeAvailable={optimizeAvailable} compareAvailable={compareAvailable} />}
    </Box>
  )
}

function StaticDashboard({ projects, period, activeProvider, planUsage }: { projects: ProjectSummary[]; period: Period; activeProvider?: string; planUsage?: PlanUsage }) {
  const { columns } = useWindowSize()
  const { dashWidth } = getLayout(columns)
  return (
    <Box flexDirection="column" width={dashWidth}>
      <PeriodTabs active={period} />
      <DashboardContent projects={projects} period={period} columns={columns} activeProvider={activeProvider} planUsage={planUsage} />
    </Box>
  )
}

export async function renderDashboard(period: Period = 'week', provider: string = 'all', refreshSeconds?: number, projectFilter?: string[], excludeFilter?: string[], customRange?: DateRange | null): Promise<void> {
  await loadPricing()
  const range = customRange ?? getPeriodRange(period)
  const filteredProjects = filterProjectsByName(await parseAllSessions(range, provider), projectFilter, excludeFilter)
  const planUsage = await getPlanUsageOrNull()
  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  patchStdoutForWindows()
  if (isTTY) {
    const { waitUntilExit } = render(
      <InteractiveDashboard initialProjects={filteredProjects} initialPeriod={period} initialProvider={provider} initialPlanUsage={planUsage ?? undefined} refreshSeconds={refreshSeconds} projectFilter={projectFilter} excludeFilter={excludeFilter} />
    )
    await waitUntilExit()
  } else {
    const { unmount } = render(<StaticDashboard projects={filteredProjects} period={period} activeProvider={provider} planUsage={planUsage ?? undefined} />, { patchConsole: false })
    unmount()
  }
}
