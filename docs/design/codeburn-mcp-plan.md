# CodeBurn MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `codeburn mcp` stdio MCP server exposing CodeBurn's usage/cost data to AI agents via two tools (`get_usage`, `get_savings`), each returning a markdown table plus typed structured JSON.

**Architecture:** Extract the existing `status --format menubar-json` aggregation into one reusable `buildMenubarPayloadForRange(periodInfo, opts)` (with an `optimize` boolean — the only expensive call, `scanAndDetect`, is skipped for `get_usage`). A long-lived in-process `McpServer` registers the two tools, injects the aggregator for testability, coalesces concurrent calls, hashes project names by default, and relies on the existing 180 s parser cache for warm reuse.

**Tech Stack:** TypeScript (ESM, `type: module`, node ≥ 22.13), commander, `@modelcontextprotocol/sdk@^1.29` (v1), zod, tsup, vitest.

---

## File Structure

- **Create `src/usage-aggregator.ts`** — owns `buildPeriodData` (moved from `main.ts`) and the extracted `buildMenubarPayloadForRange(periodInfo, opts): Promise<MenubarPayload>`. Single responsibility: turn a resolved date range + filters into a `MenubarPayload`.
- **Create `src/mcp/redact.ts`** — `pseudonym()` + `redactProjectNames(payload, include)`. Privacy only.
- **Create `src/mcp/tables.ts`** — markdown renderers (`renderSummaryTable`, `renderBreakdownTable`, `renderSavingsTable`). Presentation only.
- **Create `src/mcp/server.ts`** — `createServer(deps)` (tool registration + handlers, aggregator injectable) and `startStdioServer(version)` (loadPricing + pre-warm + stdio transport).
- **Modify `src/main.ts`** — import `buildPeriodData`/`buildMenubarPayloadForRange` from the aggregator; refactor the `status` menubar branch to call the aggregator; add `.command('mcp')`.
- **Modify `package.json`** — add `@modelcontextprotocol/sdk` + `zod` deps.
- **Modify `tsup.config.ts`** — `external: ['@modelcontextprotocol/sdk', 'zod']`.
- **Create tests** — `tests/usage-aggregator.test.ts`, `tests/mcp-redact.test.ts`, `tests/mcp-tables.test.ts`, `tests/mcp-server.test.ts`.

Internal MCP period names map to CodeBurn's: `today→today`, `last_7_days→week`, `last_30_days→30days`, `month_to_date→month`, `last_6_months→all` (≈6 months).

---

## Task 1: Add dependencies and externalize them in the bundle

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `tsup.config.ts`

- [ ] **Step 1: Add runtime deps**

Run: `npm install @modelcontextprotocol/sdk@^1.29.0 zod@^3.25.0 --save-exact=false`
Expected: both appear under `"dependencies"` in `package.json`; `node_modules/@modelcontextprotocol/sdk` and `node_modules/zod` exist.

- [ ] **Step 2: Externalize them so they are not inlined into `dist/main.js`**

Edit `tsup.config.ts` to:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  external: ['@modelcontextprotocol/sdk', 'zod'],
})
```

- [ ] **Step 3: Build and confirm the SDK is external (not bundled)**

Run: `npm run build && node -e "const s=require('fs').readFileSync('dist/main.js','utf8'); if(/from'@modelcontextprotocol\/sdk|require\(.@modelcontextprotocol\/sdk./.test(s.replace(/\s/g,''))||!/McpServer/.test(s)){} console.log('built, bytes', s.length)"`
Expected: build succeeds, prints `built, bytes <n>`. (The SDK isn't imported anywhere yet, so this just verifies the config builds.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsup.config.ts
git commit -m "build(mcp): add @modelcontextprotocol/sdk + zod, externalize in tsup"
```

---

## Task 2: Move `buildPeriodData` into a shared module

`buildPeriodData` is currently a private function in `main.ts:410`. The aggregator needs it, so move it to the new module and import it back into `main.ts`.

**Files:**
- Create: `src/usage-aggregator.ts`
- Modify: `src/main.ts:410` (remove local def), import section

- [ ] **Step 1: Create the module with `buildPeriodData` moved verbatim**

Create `src/usage-aggregator.ts`. Move the entire `function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData { ... }` body from `main.ts` into it, exported, with imports it needs:

```ts
import type { ProjectSummary } from './types.js'
import { type PeriodData } from './menubar-json.js'

export function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  // ... exact body moved from main.ts:410 ...
}
```

(Copy the body unchanged. Add any imports the body references — e.g. `getShortModelName` from `./models.js` — until `npx tsc --noEmit` is clean.)

- [ ] **Step 2: Update `main.ts` to import it and delete the local copy**

Remove the `function buildPeriodData(...) {...}` at `main.ts:410`. Add to the import block near the top:

```ts
import { buildPeriodData } from './usage-aggregator.js'
```

- [ ] **Step 3: Typecheck + run the full suite (parity guard)**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean; all existing tests pass (the `status` paths still use `buildPeriodData`, now imported).

- [ ] **Step 4: Commit**

```bash
git add src/usage-aggregator.ts src/main.ts
git commit -m "refactor: move buildPeriodData into usage-aggregator module"
```

---

## Task 3: Extract `buildMenubarPayloadForRange`

Move the `status` menubar-json aggregation block (`main.ts:485–759`, everything after `periodInfo`/`now` are computed, ending at the `console.log`) into the aggregator as a function that **returns** the payload instead of printing it.

**Files:**
- Modify: `src/usage-aggregator.ts` (add the function)
- Modify: `src/main.ts:476–761` (call it)
- Test: existing `tests/cli-status-menubar.test.ts` is the parity guard

- [ ] **Step 1: Add the function signature + types to `src/usage-aggregator.ts`**

```ts
import { homedir } from 'node:os'
import type { ProjectSummary, DateRange } from './types.js'
import { type PeriodData, type ProviderCost, type BreakdownArrays, type MenubarPayload, buildMenubarPayload } from './menubar-json.js'
import { parseAllSessions, getAllProviders, filterProjectsByName, filterProjectsByDays } from './parser.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from './day-aggregator.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { scanAndDetect } from './optimize.js'
import { hydrateCache, loadDailyCache, getDaysInRange, toDateString, BACKFILL_DAYS, type DailyCache } from './daily-cache.js'

export type PeriodInfo = { range: DateRange; label: string }
export type AggregateOpts = {
  provider?: string
  project?: string[]
  exclude?: string[]
  daysSelection?: { range: DateRange; label: string; days: Set<string> } | null
  optimize?: boolean
}

export async function buildMenubarPayloadForRange(
  periodInfo: PeriodInfo,
  opts: AggregateOpts = {},
): Promise<MenubarPayload> {
  const pf = opts.provider ?? 'all'
  const daysSelection = opts.daysSelection ?? null
  const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project ?? [], opts.exclude ?? [])
  // ... moved block from main.ts:485–757 (now/todayStart/... through breakdowns) ...
  const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
  return buildMenubarPayload(currentData, providers, optimize, dailyHistory, retryTax, routingWaste, breakdowns)
}
```

Move lines `main.ts:485–757` (from `const now = new Date()` through the `breakdowns` IIFE) into the body unchanged. The block already references only the symbols imported above plus `homedir()`. `hydrateCache` is imported from `./daily-cache.js` (same module as `loadDailyCache`); if tsc reports a different source, follow the import it suggests.

- [ ] **Step 2: Precondition note — pricing**

The block assumes `loadPricing()` already ran. The `status` action calls it at `main.ts:473`; the MCP server will call it at startup (Task 6). Do **not** call `loadPricing()` inside the function.

- [ ] **Step 3: Refactor the `status` menubar branch to call it**

Replace `main.ts:485–760` (the inline block + `console.log` + `return`) with:

```ts
const payload = await buildMenubarPayloadForRange(periodInfo, {
  provider: pf,
  project: opts.project,
  exclude: opts.exclude,
  daysSelection,
  optimize: opts.optimize !== false,
})
console.log(JSON.stringify(payload))
return
```

Keep `main.ts:477–484` (the `daysSelection`/`customRange`/`daySelection`/`periodInfo` resolution) — `periodInfo` and `daysSelection` are the inputs now passed in. Add `buildMenubarPayloadForRange` to the existing import from `./usage-aggregator.js`.

- [ ] **Step 4: Typecheck + parity test**

Run: `npx tsc --noEmit && npm test -- cli-status-menubar`
Expected: clean typecheck; `tests/cli-status-menubar.test.ts` passes — i.e. `status --format menubar-json` output is unchanged (parity).

- [ ] **Step 5: Add a direct unit test for the aggregator**

Create `tests/usage-aggregator.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildMenubarPayloadForRange } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'

describe('buildMenubarPayloadForRange', () => {
  it('returns a zero payload with no data and skips optimize when optimize:false', async () => {
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { provider: 'all', optimize: false })
    expect(payload.current.cost).toBe(0)
    expect(payload.current.calls).toBe(0)
    expect(payload.optimize.findingCount).toBe(0)
    expect(Array.isArray(payload.current.topProjects)).toBe(true)
  })
})
```

Run: `npm test -- usage-aggregator`
Expected: PASS (uses the empty real environment; `scanAndDetect` not called because `optimize:false`).

- [ ] **Step 6: Commit**

```bash
git add src/usage-aggregator.ts src/main.ts tests/usage-aggregator.test.ts
git commit -m "refactor: extract buildMenubarPayloadForRange for reuse by MCP"
```

---

## Task 4: Project-name redaction

**Files:**
- Create: `src/mcp/redact.ts`
- Test: `tests/mcp-redact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { pseudonym, redactProjectNames } from '../src/mcp/redact.js'
import type { MenubarPayload } from '../src/menubar-json.js'

function payload(): MenubarPayload {
  const base = {
    name: 'secret-client-repo', cost: 5, sessions: 2, avgCostPerSession: 2.5, sessionDetails: [],
  }
  return {
    generated: '', optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] }, history: { daily: [] },
    current: {
      label: 'Today', cost: 5, calls: 10, sessions: 2, oneShotRate: null, inputTokens: 0, outputTokens: 0,
      cacheHitPercent: 0, topActivities: [], topModels: [], providers: {},
      topProjects: [base], modelEfficiency: [],
      topSessions: [{ project: 'secret-client-repo', cost: 5, calls: 10, date: '2026-06-01' }],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [], skills: [], subagents: [], mcpServers: [],
    },
  } as MenubarPayload
}

describe('redact', () => {
  it('pseudonym is stable and path-free', () => {
    expect(pseudonym('a')).toBe(pseudonym('a'))
    expect(pseudonym('secret-client-repo')).toMatch(/^project-[0-9a-f]{6}$/)
  })
  it('hashes project names by default, preserves numbers', () => {
    const out = redactProjectNames(payload(), false)
    expect(out.current.topProjects[0]!.name).toMatch(/^project-[0-9a-f]{6}$/)
    expect(out.current.topSessions[0]!.project).toMatch(/^project-[0-9a-f]{6}$/)
    expect(out.current.topProjects[0]!.cost).toBe(5)
  })
  it('keeps real names when include=true', () => {
    const out = redactProjectNames(payload(), true)
    expect(out.current.topProjects[0]!.name).toBe('secret-client-repo')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- mcp-redact`
Expected: FAIL ("Cannot find module '../src/mcp/redact.js'").

- [ ] **Step 3: Implement**

Create `src/mcp/redact.ts`:

```ts
import { createHash } from 'node:crypto'
import type { MenubarPayload } from '../menubar-json.js'

export function pseudonym(name: string): string {
  return `project-${createHash('sha256').update(name).digest('hex').slice(0, 6)}`
}

export function redactProjectNames(payload: MenubarPayload, includeNames: boolean): MenubarPayload {
  if (includeNames) return payload
  return {
    ...payload,
    current: {
      ...payload.current,
      topProjects: payload.current.topProjects.map(p => ({ ...p, name: pseudonym(p.name) })),
      topSessions: payload.current.topSessions.map(s => ({ ...s, project: pseudonym(s.project) })),
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- mcp-redact`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/redact.ts tests/mcp-redact.test.ts
git commit -m "feat(mcp): hash project names by default with opt-in reveal"
```

---

## Task 5: Markdown table renderers

**Files:**
- Create: `src/mcp/tables.ts`
- Test: `tests/mcp-tables.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-tables.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderSummaryTable, renderBreakdownTable, renderSavingsTable } from '../src/mcp/tables.js'
import type { MenubarPayload } from '../src/menubar-json.js'

function payload(): MenubarPayload {
  return {
    generated: '', optimize: { findingCount: 1, savingsUSD: 2.5, topFindings: [{ title: 'Trim system prompt', impact: 'high', savingsUSD: 2.5 }] }, history: { daily: [] },
    current: {
      label: 'Last 7 Days', cost: 12.5, calls: 100, sessions: 4, oneShotRate: 0.5, inputTokens: 1000, outputTokens: 500,
      cacheHitPercent: 80, topActivities: [{ name: 'feature', cost: 8, turns: 30, oneShotRate: 0.6 }],
      topModels: [{ name: 'Opus 4.8', cost: 10, calls: 60 }], providers: { 'claude code': 12.5 },
      topProjects: [{ name: 'project-abc123', cost: 12.5, sessions: 4, avgCostPerSession: 3.125, sessionDetails: [] }],
      modelEfficiency: [], topSessions: [],
      retryTax: { totalUSD: 1.2, retries: 4, editTurns: 20, byModel: [{ name: 'Opus 4.8', taxUSD: 1.2, retries: 4, retriesPerEdit: 0.2 }] },
      routingWaste: { totalSavingsUSD: 3, baselineModel: 'Haiku 4.5', baselineCostPerEdit: 0.01, byModel: [{ name: 'Opus 4.8', costPerEdit: 0.05, editTurns: 20, actualUSD: 1, counterfactualUSD: 0.2, savingsUSD: 0.8 }] },
      tools: [], skills: [], subagents: [], mcpServers: [],
    },
  } as MenubarPayload
}

describe('tables', () => {
  it('summary shows headline cost and top models', () => {
    const t = renderSummaryTable(payload())
    expect(t).toContain('Last 7 Days')
    expect(t).toContain('Opus 4.8')
    expect(t).toContain('| Model | Cost | Calls |')
  })
  it('breakdown by provider lists providers', () => {
    expect(renderBreakdownTable(payload(), 'provider', 20)).toContain('claude code')
  })
  it('breakdown handles empty dimension gracefully', () => {
    const p = payload(); p.current.topActivities = []
    expect(renderBreakdownTable(p, 'task', 20)).toContain('no data')
  })
  it('savings shows retry tax and routing waste', () => {
    const t = renderSavingsTable(payload())
    expect(t).toContain('Retry tax')
    expect(t).toContain('Routing waste')
    expect(t).toContain('Trim system prompt')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- mcp-tables`
Expected: FAIL ("Cannot find module '../src/mcp/tables.js'").

- [ ] **Step 3: Implement**

Create `src/mcp/tables.ts`:

```ts
import { formatCost, formatTokens } from '../format.js'
import type { MenubarPayload } from '../menubar-json.js'

export type BreakdownBy = 'project' | 'model' | 'task' | 'provider'

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  if (rows.length === 0) return `${head}\n${sep}\n| _(no data)_ |${' |'.repeat(headers.length - 1)}`
  return [head, sep, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
}

const pct = (n: number) => `${Math.round(n)}%`
const oneShot = (r: number | null) => (r === null ? 'n/a' : pct(r * 100))

export function renderSummaryTable(p: MenubarPayload): string {
  const c = p.current
  return [
    `**${c.label}** — ${formatCost(c.cost)} · ${c.calls} calls · ${c.sessions} sessions`,
    `cache hit ${pct(c.cacheHitPercent)} · one-shot ${oneShot(c.oneShotRate)} · in ${formatTokens(c.inputTokens)} / out ${formatTokens(c.outputTokens)}`,
    '',
    '_Top models_',
    mdTable(['Model', 'Cost', 'Calls'], c.topModels.slice(0, 5).map(m => [m.name, formatCost(m.cost), String(m.calls)])),
    '',
    '_Top projects_',
    mdTable(['Project', 'Cost', 'Sessions'], c.topProjects.slice(0, 5).map(x => [x.name, formatCost(x.cost), String(x.sessions)])),
  ].join('\n')
}

export function renderBreakdownTable(p: MenubarPayload, by: BreakdownBy, limit: number): string {
  const c = p.current
  if (by === 'model') return mdTable(['Model', 'Cost', 'Calls'], c.topModels.slice(0, limit).map(m => [m.name, formatCost(m.cost), String(m.calls)]))
  if (by === 'project') return mdTable(['Project', 'Cost', 'Sessions'], c.topProjects.slice(0, limit).map(x => [x.name, formatCost(x.cost), String(x.sessions)]))
  if (by === 'task') return mdTable(['Task', 'Cost', 'Turns', 'One-shot'], c.topActivities.slice(0, limit).map(a => [a.name, formatCost(a.cost), String(a.turns), oneShot(a.oneShotRate)]))
  return mdTable(['Provider', 'Cost'], Object.entries(c.providers).sort(([, a], [, b]) => b - a).slice(0, limit).map(([name, cost]) => [name, formatCost(cost)]))
}

export function renderSavingsTable(p: MenubarPayload): string {
  const c = p.current
  const findings = mdTable(['Finding', 'Impact', 'Saves'], p.optimize.topFindings.slice(0, 10).map(f => [f.title, f.impact, formatCost(f.savingsUSD)]))
  const retry = mdTable(['Model', 'Retry tax', 'Retries'], c.retryTax.byModel.map(m => [m.name, formatCost(m.taxUSD), String(m.retries)]))
  const routing = mdTable(['Model', 'Overpaid', 'vs baseline'], c.routingWaste.byModel.map(m => [m.name, formatCost(m.savingsUSD), c.routingWaste.baselineModel]))
  return [
    `**Savings — ${c.label}**`,
    `Optimize findings: ${p.optimize.findingCount} (≈ ${formatCost(p.optimize.savingsUSD)})`,
    findings, '',
    `_Retry tax_ — ${formatCost(c.retryTax.totalUSD)} on ${c.retryTax.retries} retries`,
    retry, '',
    `_Routing waste_ — ${formatCost(c.routingWaste.totalSavingsUSD)} vs ${c.routingWaste.baselineModel || 'n/a'}`,
    routing,
  ].join('\n')
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- mcp-tables`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tables.ts tests/mcp-tables.test.ts
git commit -m "feat(mcp): markdown table renderers for usage and savings"
```

---

## Task 6: MCP server (tools, schemas, handlers, coalescing)

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp-server.test.ts`

- [ ] **Step 1: Write the failing test (in-memory transport, injected aggregator)**

Create `tests/mcp-server.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/mcp/server.js'
import type { MenubarPayload } from '../src/menubar-json.js'

function fakePayload(calls = 100): MenubarPayload {
  return {
    generated: '', optimize: { findingCount: 1, savingsUSD: 2, topFindings: [{ title: 'X', impact: 'high', savingsUSD: 2 }] }, history: { daily: [] },
    current: {
      label: 'Today', cost: 9, calls, sessions: 1, oneShotRate: 0.5, inputTokens: 10, outputTokens: 5, cacheHitPercent: 50,
      topActivities: [{ name: 'feature', cost: 9, turns: 5, oneShotRate: 0.5 }], topModels: [{ name: 'Opus 4.8', cost: 9, calls }],
      providers: { 'claude code': 9 }, topProjects: [{ name: 'real-repo', cost: 9, sessions: 1, avgCostPerSession: 9, sessionDetails: [] }],
      modelEfficiency: [], topSessions: [{ project: 'real-repo', cost: 9, calls, date: '2026-06-01' }],
      retryTax: { totalUSD: 1, retries: 2, editTurns: 5, byModel: [{ name: 'Opus 4.8', taxUSD: 1, retries: 2, retriesPerEdit: 0.4 }] },
      routingWaste: { totalSavingsUSD: 1, baselineModel: 'Haiku 4.5', baselineCostPerEdit: 0.01, byModel: [] },
      tools: [], skills: [], subagents: [], mcpServers: [],
    },
  } as MenubarPayload
}

async function connect(aggregate: any) {
  const server = createServer({ version: 'test', aggregate })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

describe('mcp server', () => {
  it('exposes exactly two read-only tools', async () => {
    const client = await connect(async () => fakePayload())
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['get_savings', 'get_usage'])
    expect(tools.find(t => t.name === 'get_usage')!.annotations?.readOnlyHint).toBe(true)
  })
  it('get_usage hashes project names by default', async () => {
    const client = await connect(async () => fakePayload())
    const res: any = await client.callTool({ name: 'get_usage', arguments: { period: 'today', by: 'project' } })
    expect(JSON.stringify(res)).not.toContain('real-repo')
    expect(JSON.stringify(res)).toMatch(/project-[0-9a-f]{6}/)
    expect(res.isError).toBeFalsy()
  })
  it('get_usage reveals names when opted in', async () => {
    const client = await connect(async () => fakePayload())
    const res: any = await client.callTool({ name: 'get_usage', arguments: { period: 'today', by: 'project', include_project_names: true } })
    expect(JSON.stringify(res)).toContain('real-repo')
  })
  it('empty data returns a friendly message, not a zero table', async () => {
    const client = await connect(async () => fakePayload(0))
    const res: any = await client.callTool({ name: 'get_usage', arguments: { period: 'today' } })
    expect(res.content[0].text.toLowerCase()).toContain('no usage')
  })
  it('aggregator failure surfaces as isError', async () => {
    const client = await connect(async () => { throw new Error('boom') })
    const res: any = await client.callTool({ name: 'get_savings', arguments: {} })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('boom')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- mcp-server`
Expected: FAIL ("Cannot find module '../src/mcp/server.js'").

- [ ] **Step 3: Implement the server**

Create `src/mcp/server.ts`:

```ts
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
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
        totals: z.object({ costUSD: z.number(), calls: z.number(), sessions: z.number(), cacheHitPercent: z.number(), oneShotRate: z.number().nullable() }),
        breakdown: z.array(z.object({ name: z.string(), costUSD: z.number() })).nullable(),
      },
      annotations: { title: 'CodeBurn — usage & cost', readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ period, by, limit, include_project_names }): Promise<CallToolResult> => {
      try {
        const payload = redactProjectNames(await getPayload(period, false), include_project_names)
        const c = payload.current
        const totals = { costUSD: c.cost, calls: c.calls, sessions: c.sessions, cacheHitPercent: c.cacheHitPercent, oneShotRate: c.oneShotRate }
        if (c.calls === 0) {
          return { content: [{ type: 'text', text: `No usage recorded for ${c.label} yet — run some coding sessions and try again.` }], structuredContent: { period: c.label, empty: true, totals, breakdown: null } }
        }
        const text = by ? renderBreakdownTable(payload, by as BreakdownBy, limit) : renderSummaryTable(payload)
        const breakdown = by ? breakdownRows(payload, by as BreakdownBy, limit) : null
        return { content: [{ type: 'text', text }], structuredContent: { period: c.label, empty: false, totals, breakdown } }
      } catch (err) {
        return { content: [{ type: 'text', text: `codeburn: failed to read usage — ${err instanceof Error ? err.message : String(err)}` }], isError: true }
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
    async ({ period, include_project_names }): Promise<CallToolResult> => {
      try {
        const payload = redactProjectNames(await getPayload(period, true), include_project_names)
        const c = payload.current
        return {
          content: [{ type: 'text', text: renderSavingsTable(payload) }],
          structuredContent: { period: c.label, optimize: payload.optimize, retryTaxUSD: c.retryTax.totalUSD, routingWasteUSD: c.routingWaste.totalSavingsUSD },
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `codeburn: failed to compute savings — ${err instanceof Error ? err.message : String(err)}` }], isError: true }
      }
    },
  )

  return server
}

function breakdownRows(p: MenubarPayload, by: BreakdownBy, limit: number): Array<{ name: string; costUSD: number }> {
  const c = p.current
  if (by === 'model') return c.topModels.slice(0, limit).map(m => ({ name: m.name, costUSD: m.cost }))
  if (by === 'project') return c.topProjects.slice(0, limit).map(x => ({ name: x.name, costUSD: x.cost }))
  if (by === 'task') return c.topActivities.slice(0, limit).map(a => ({ name: a.name, costUSD: a.cost }))
  return Object.entries(c.providers).sort(([, a], [, b]) => b - a).slice(0, limit).map(([name, cost]) => ({ name, costUSD: cost }))
}

export async function startStdioServer(version: string): Promise<void> {
  await loadPricing()
  const server = createServer({ version })
  // Pre-warm the parser cache for the common case; ignore failures.
  void buildMenubarPayloadForRange(getDateRange('today'), { provider: 'all', optimize: false }).catch(() => {})
  await server.connect(new StdioServerTransport())
}
```

> If the installed SDK rejects the raw-shape `inputSchema`/`outputSchema` (object of zod validators), wrap each in `z.object({ ... })` — the in-memory test in Step 4 will surface this immediately. Likewise, if `InMemoryTransport`'s import path differs, it is exported from `@modelcontextprotocol/sdk/inMemory.js` in v1.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- mcp-server`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp-server.test.ts
git commit -m "feat(mcp): get_usage + get_savings tools with annotations, schemas, coalescing"
```

---

## Task 7: Wire the `codeburn mcp` command

**Files:**
- Modify: `src/main.ts` (add command + stdout guard)

- [ ] **Step 1: Add the command**

In `src/main.ts`, alongside the other `.command(...)` registrations (e.g. after the `status` block), add:

```ts
program
  .command('mcp')
  .description('Run a Model Context Protocol server (stdio) exposing usage + savings to AI agents')
  .action(async () => {
    // stdout MUST carry only JSON-RPC; route stray logs to stderr.
    console.log = ((...args: unknown[]) => process.stderr.write(args.join(' ') + '\n')) as typeof console.log
    const { startStdioServer } = await import('./mcp/server.js')
    await startStdioServer(version)
  })
```

(`version` is already in scope at `main.ts:30`.)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds. `src/mcp/server.ts` is reachable from the `main.ts` import graph (via the dynamic import), so tsup bundles it; the `@modelcontextprotocol/sdk` and `zod` imports stay external (Task 1).

- [ ] **Step 3: Smoke-test the built server over stdio**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/cli.js mcp 2>/dev/null | head -2
```
Expected: two JSON-RPC result lines on stdout; the second lists `get_usage` and `get_savings`. No non-JSON noise on stdout (warnings, if any, went to stderr).

- [ ] **Step 4: Verify the SDK is external in the bundle**

Run: `node -e "const s=require('fs').readFileSync('dist/main.js','utf8'); console.log('McpServer source inlined?', /class McpServer/.test(s))"`
Expected: `McpServer source inlined? false` (it's imported from node_modules at runtime, not bundled).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(mcp): add 'codeburn mcp' stdio command with stdout guard"
```

---

## Task 8: Full suite + final verification

**Files:** none (verification)

- [ ] **Step 1: Run everything**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: typecheck clean; all tests pass (incl. the pre-existing suite — parity preserved); build succeeds.

- [ ] **Step 2: Manual end-to-end against real data (optional but recommended)**

Run: `node dist/cli.js mcp` then, in another shell, point a local MCP client (or the smoke command from Task 7) at it and call `get_usage {"period":"today"}` and `get_savings {"period":"last_7_days"}`. Confirm tables render and project names are hashed.

- [ ] **Step 3: Commit any cleanup**

```bash
git add -A && git commit -m "chore(mcp): final verification" || echo "nothing to commit"
```

---

## Deferred (not in v1 — see spec §10 and note below)

- **Per-provider graceful degradation (`degraded[]`).** The spec (§5/§8) called for `allSettled` per-provider isolation. That requires changing the shared `parseAllSessions` loop (`parser.ts:2133`), which every command uses — out of scope for v1 to avoid destabilizing the parser. v1 handles failures at the tool boundary (`isError: true` with the message). A malformed provider aborting a scan is a **pre-existing** behavior shared with the `status`/menubar path, not introduced here. *This is the one intentional deviation from the committed spec.*
- HTTP/SSE transport, `compare_periods`, MCP prompts/resources, README + registry listings.

## Self-Review

- **Spec coverage:** in-process stdio server (Task 6/7) ✓; cheap vs optimize split via `optimize` flag (Task 3, refined — `scanAndDetect` is the only expensive call) ✓; 2 tools with annotations + outputSchema + isError (Task 6) ✓; hash-by-default redaction (Task 4) ✓; in-flight coalescing + pre-warm (Task 6) ✓; tsup external + pinned deps (Task 1) ✓; stdout guard (Task 7) ✓; period-enum rename + `last_6_months` semantics (Task 6 + instructions) ✓; empty-state message (Task 6) ✓; token discipline via `limit` + summarized history (Task 6, no daily array returned) ✓. Deviation: per-provider `degraded[]` deferred (documented above).
- **Placeholders:** none — every code step has full source; the only "move verbatim" steps (Tasks 2–3) are mechanical relocations of existing, cited code, gated by the existing parity test.
- **Type consistency:** `buildMenubarPayloadForRange(PeriodInfo, AggregateOpts)`, `redactProjectNames(MenubarPayload, boolean)`, `renderBreakdownTable(payload, BreakdownBy, limit)`, `createServer({version, aggregate})` — names/signatures consistent across tasks and tests.
