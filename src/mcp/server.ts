import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getDateRange } from '../cli-date.js'
import { loadPricing } from '../models.js'
import { buildMenubarPayloadForRange, type PeriodInfo } from '../usage-aggregator.js'
import type { MenubarPayload } from '../menubar-json.js'
import { redactProjectNames } from './redact.js'
import { renderSummaryTable, renderBreakdownTable, renderSavingsTable, type BreakdownBy } from './tables.js'

const PERIOD = { today: 'today', last_7_days: 'week', last_30_days: '30days', month_to_date: 'month', last_6_months: 'all' } as const
type McpPeriod = keyof typeof PERIOD
const periodSchema = z.enum(['today', 'last_7_days', 'last_30_days', 'month_to_date', 'last_6_months'])

type Aggregate = (periodInfo: PeriodInfo, opts: { provider?: string; optimize?: boolean }) => Promise<MenubarPayload>

const INSTRUCTIONS =
  'CodeBurn exposes local AI-coding spend data. Use get_usage for spend/usage and breakdowns (fast); ' +
  'use get_savings to find cost reductions (slower — runs a deeper analysis). Project names are pseudonymized ' +
  'unless include_project_names is true. All data is read locally from this machine; last_6_months is the widest ' +
  'window. Numbers reflect the most recent scan and may lag the current session by up to a few minutes.'

function breakdownRows(p: MenubarPayload, by: BreakdownBy, limit: number): Array<{ name: string; costUSD: number; estimatedCostUSD?: number }> {
  const c = p.current
  if (by === 'model') return c.topModels.slice(0, limit).map(m => ({ name: m.name, costUSD: m.cost, estimatedCostUSD: m.estimatedCostUSD ?? 0 }))
  if (by === 'project') return c.topProjects.slice(0, limit).map(x => ({ name: x.name, costUSD: x.cost }))
  if (by === 'task') return c.topActivities.slice(0, limit).map(a => ({ name: a.name, costUSD: a.cost }))
  return Object.entries(c.providers).sort(([, a], [, b]) => b - a).slice(0, limit).map(([name, cost]) => ({ name, costUSD: cost }))
}

export function createServer(deps: { version: string; aggregate?: Aggregate }): McpServer {
  const aggregate = deps.aggregate ?? buildMenubarPayloadForRange
  const inflight = new Map<string, Promise<MenubarPayload>>()

  const getPayload = (period: McpPeriod, optimize: boolean): Promise<MenubarPayload> => {
    const key = `${optimize ? 'sav' : 'use'}:${period}`
    const existing = inflight.get(key)
    if (existing) return existing
    const { range, label } = getDateRange(PERIOD[period])
    const p = aggregate({ range, label }, { provider: 'all', optimize }).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  const server = new McpServer({ name: 'codeburn', version: deps.version }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'get_usage',
    {
      title: 'CodeBurn — usage & cost',
      description:
        'Show AI coding token spend and usage for a period. Omit `by` for a headline summary; set `by` to break ' +
        'it down by project, model, task, or provider (Claude Code / Cursor / Codex). Fast. Local to this machine.',
      inputSchema: {
        period: periodSchema.default('today'),
        by: z.enum(['project', 'model', 'task', 'provider']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        include_project_names: z.boolean().default(false),
      },
      outputSchema: {
        period: z.string(),
        empty: z.boolean(),
        totals: z.object({ costUSD: z.number(), estimatedCostUSD: z.number(), calls: z.number(), sessions: z.number(), cacheHitPercent: z.number(), oneShotRate: z.number().nullable() }),
        breakdown: z.array(z.object({ name: z.string(), costUSD: z.number(), estimatedCostUSD: z.number().optional() })).nullable(),
      },
      annotations: { title: 'CodeBurn — usage & cost', readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ period, by, limit, include_project_names }) => {
      try {
        const payload = redactProjectNames(await getPayload(period, false), include_project_names)
        const c = payload.current
        const totals = { costUSD: c.cost, estimatedCostUSD: c.estimatedCostUSD ?? 0, calls: c.calls, sessions: c.sessions, cacheHitPercent: c.cacheHitPercent, oneShotRate: c.oneShotRate }
        if (c.calls === 0) {
          return {
            content: [{ type: 'text' as const, text: `No usage recorded for ${c.label} yet — run some coding sessions and try again.` }],
            structuredContent: { period: c.label, empty: true, totals, breakdown: null },
          }
        }
        const text = by ? renderBreakdownTable(payload, by, limit) : renderSummaryTable(payload)
        const breakdown = by ? breakdownRows(payload, by, limit) : null
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { period: c.label, empty: false, totals, breakdown },
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `codeburn: failed to read usage — ${err instanceof Error ? err.message : String(err)}` }],
          structuredContent: { period: 'unknown', empty: true, totals: { costUSD: 0, estimatedCostUSD: 0, calls: 0, sessions: 0, cacheHitPercent: 0, oneShotRate: null }, breakdown: null },
          isError: true,
        }
      }
    },
  )

  server.registerTool(
    'get_savings',
    {
      title: 'CodeBurn — savings opportunities',
      description:
        'Find ways to reduce AI coding cost for a period: optimization findings, retry tax (money spent re-doing ' +
        'work), and routing waste (what you would have saved on a cheaper model). Slower than get_usage.',
      inputSchema: { period: periodSchema.default('last_7_days'), include_project_names: z.boolean().default(false) },
      outputSchema: {
        period: z.string(),
        optimize: z.object({ findingCount: z.number(), savingsUSD: z.number(), topFindings: z.array(z.object({ title: z.string(), impact: z.string(), savingsUSD: z.number() })) }),
        retryTaxUSD: z.number(),
        routingWasteUSD: z.number(),
      },
      annotations: { title: 'CodeBurn — savings opportunities', readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ period, include_project_names }) => {
      try {
        const payload = redactProjectNames(await getPayload(period, true), include_project_names)
        const c = payload.current
        return {
          content: [{ type: 'text' as const, text: renderSavingsTable(payload) }],
          structuredContent: { period: c.label, optimize: payload.optimize, retryTaxUSD: c.retryTax.totalUSD, routingWasteUSD: c.routingWaste.totalSavingsUSD },
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `codeburn: failed to compute savings — ${err instanceof Error ? err.message : String(err)}` }],
          structuredContent: { period: 'unknown', optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] }, retryTaxUSD: 0, routingWasteUSD: 0 },
          isError: true,
        }
      }
    },
  )

  return server
}

export async function startStdioServer(version: string): Promise<void> {
  await loadPricing()
  const server = createServer({ version })
  await server.connect(new StdioServerTransport())
}
