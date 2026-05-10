import { describe, it, expect } from 'vitest'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import { aggregateModels, renderTable, renderMarkdown, renderJson, renderCsv, type ModelReportRow } from '../src/models-report.js'
import type {
  ProjectSummary,
  SessionSummary,
  ClassifiedTurn,
  ParsedApiCall,
  TokenUsage,
  TaskCategory,
} from '../src/types.js'

function emptyTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
}

function makeCall(opts: {
  provider: string
  model: string
  costUSD: number
  input?: number
  output?: number
  cacheWrite?: number
  cacheRead?: number
}): ParsedApiCall {
  return {
    provider: opts.provider,
    model: opts.model,
    usage: {
      ...emptyTokens(),
      inputTokens: opts.input ?? 0,
      outputTokens: opts.output ?? 0,
      cacheCreationInputTokens: opts.cacheWrite ?? 0,
      cacheReadInputTokens: opts.cacheRead ?? 0,
    },
    costUSD: opts.costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-09T00:00:00.000Z',
    bashCommands: [],
    deduplicationKey: `${opts.provider}-${opts.model}-${opts.costUSD}`,
  }
}

function makeTurn(category: TaskCategory, calls: ParsedApiCall[]): ClassifiedTurn {
  return {
    userMessage: 'test',
    assistantCalls: calls,
    timestamp: '2026-05-09T00:00:00.000Z',
    sessionId: 's1',
    category,
    retries: 0,
    hasEdits: false,
  }
}

function makeSession(turns: ClassifiedTurn[]): SessionSummary {
  return {
    sessionId: 's1',
    project: 'p',
    firstTimestamp: '2026-05-09T00:00:00.000Z',
    lastTimestamp: '2026-05-09T00:00:00.000Z',
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 0,
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
}

function makeProject(turns: ClassifiedTurn[]): ProjectSummary {
  return {
    project: 'p',
    projectPath: '/tmp/p',
    sessions: [makeSession(turns)],
    totalCostUSD: 0,
    totalApiCalls: 0,
  }
}

describe('aggregateModels', () => {
  it('groups by (provider, model) and sorts by cost descending in default mode', async () => {
    const project = makeProject([
      makeTurn('feature', [
        makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', input: 1000, output: 200, cacheWrite: 500, cacheRead: 8000, costUSD: 5.0 }),
      ]),
      makeTurn('debugging', [
        makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', input: 800, output: 100, cacheWrite: 300, cacheRead: 5000, costUSD: 3.5 }),
      ]),
      makeTurn('feature', [
        makeCall({ provider: 'codex', model: 'gpt-5', input: 600, output: 80, costUSD: 1.2 }),
      ]),
    ])
    const rows = await aggregateModels([project])
    expect(rows.map(r => `${r.provider}:${r.model}`)).toEqual(['claude:claude-sonnet-4-6', 'codex:gpt-5'])
    const claudeRow = rows[0]!
    expect(claudeRow.inputTokens).toBe(1800)
    expect(claudeRow.outputTokens).toBe(300)
    expect(claudeRow.cacheWriteTokens).toBe(800)
    expect(claudeRow.cacheReadTokens).toBe(13000)
    expect(claudeRow.costUSD).toBeCloseTo(8.5, 6)
    expect(claudeRow.calls).toBe(2)
    expect(claudeRow.totalTokens).toBe(1800 + 300 + 800 + 13000)
  })

  it('reports the dominant task type with its cost share in default mode', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 6.0, input: 100, output: 20 })]),
      makeTurn('debugging', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
      makeTurn('refactoring', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
    ])
    const rows = await aggregateModels([project])
    expect(rows[0]!.topCategory).toBe('feature')
    expect(rows[0]!.topCategoryShare).toBeCloseTo(0.6, 3)
  })

  it('explodes rows by task in byTask mode and groups them so renderer can blank repeats', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 6.0, input: 100, output: 20 })]),
      makeTurn('debugging', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'gpt-5', costUSD: 1.0, input: 60, output: 10 })]),
    ])
    const rows = await aggregateModels([project], { byTask: true })
    expect(rows).toHaveLength(3)
    // Group order: claude (8.0) before codex (1.0); within claude, feature (6.0) before debugging (2.0).
    expect(rows.map(r => `${r.provider}:${r.model}:${r.category}`)).toEqual([
      'claude:claude-sonnet-4-6:feature',
      'claude:claude-sonnet-4-6:debugging',
      'codex:gpt-5:feature',
    ])
  })

  it('respects taskFilter by excluding non-matching turns from every bucket', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 5.0, input: 100, output: 20 })]),
      makeTurn('debugging', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
    ])
    const rows = await aggregateModels([project], { taskFilter: 'feature' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.costUSD).toBeCloseTo(5.0, 6)
  })

  it('applies topN and minCost filters', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 5.0, input: 100, output: 20 })]),
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'gpt-5', costUSD: 0.5, input: 50, output: 10 })]),
      makeTurn('feature', [makeCall({ provider: 'cursor', model: 'auto', costUSD: 0.001, input: 10, output: 1 })]),
    ])
    const top = await aggregateModels([project], { topN: 1 })
    expect(top).toHaveLength(1)
    const above = await aggregateModels([project], { minCost: 0.01 })
    expect(above.find(r => r.provider === 'cursor')).toBeUndefined()
  })

  it('counts reasoning tokens as output tokens', async () => {
    const project = makeProject([
      makeTurn('feature', [
        {
          provider: 'codex',
          model: 'gpt-5',
          usage: { ...emptyTokens(), inputTokens: 100, outputTokens: 50, reasoningTokens: 200 },
          costUSD: 1.0,
          tools: [],
          mcpTools: [],
          skills: [],
          hasAgentSpawn: false,
          hasPlanMode: false,
          speed: 'standard',
          timestamp: '2026-05-09T00:00:00.000Z',
          bashCommands: [],
          deduplicationKey: 'k',
        },
      ]),
    ])
    const rows = await aggregateModels([project])
    expect(rows[0]!.outputTokens).toBe(250)
  })
})

describe('renderTable', () => {
  function visibleWidth(line: string): number {
    return stripAnsi(line).length
  }

  function row(partial: Partial<ModelReportRow>): ModelReportRow {
    return {
      provider: 'claude',
      providerDisplayName: 'Claude',
      model: 'claude-sonnet-4-6',
      modelDisplayName: 'Sonnet 4.6',
      category: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUSD: 0,
      calls: 0,
      ...partial,
    }
  }

  it('blanks repeated provider/model cells in byTask mode but keeps them in default mode', () => {
    const rows: ModelReportRow[] = [
      row({ category: 'feature', costUSD: 7.78, inputTokens: 512_000, outputTokens: 98_000, cacheWriteTokens: 1_400_000, cacheReadTokens: 6_200_000, totalTokens: 8_210_000 }),
      row({ category: 'debugging', costUSD: 5.31, inputTokens: 380_000, outputTokens: 71_000, cacheWriteTokens: 920_000, cacheReadTokens: 4_100_000, totalTokens: 5_471_000 }),
    ]
    const out = renderTable(rows, { byTask: true, showTotals: false, terminalWidth: 200 })
    const lines = out.split('\n')
    // Layout: top border, header, header-separator, data..., bottom border.
    const dataLines = lines.slice(3, -1)
    expect(dataLines[0]).toContain('Sonnet 4.6')
    expect(dataLines[0]).toContain('Feature Dev')
    expect(dataLines[1]).not.toContain('Sonnet 4.6')
    expect(dataLines[1]).not.toContain('Claude')
    expect(dataLines[1]).toContain('Debugging')
  })

  it('keeps provider/model cells on every row in default mode', () => {
    const rows: ModelReportRow[] = [
      row({ topCategory: 'feature', topCategoryShare: 0.6, costUSD: 5.0 }),
      row({ provider: 'codex', providerDisplayName: 'Codex', model: 'gpt-5', modelDisplayName: 'GPT-5', topCategory: 'debugging', topCategoryShare: 0.4, costUSD: 1.2 }),
    ]
    const out = renderTable(rows, { byTask: false, showTotals: false, terminalWidth: 200 })
    const dataLines = out.split('\n').slice(3, -1)
    expect(dataLines[0]).toContain('Sonnet 4.6')
    expect(dataLines[1]).toContain('GPT-5')
  })

  it('drops cache columns when terminal is narrow', () => {
    const rows: ModelReportRow[] = [row({ topCategory: 'feature', topCategoryShare: 1, costUSD: 1 })]
    const wide = renderTable(rows, { showTotals: false, terminalWidth: 200 })
    const narrow = renderTable(rows, { showTotals: false, terminalWidth: 80 })
    expect(wide).toContain('Cache Write')
    expect(narrow).not.toContain('Cache Write')
    expect(narrow).not.toContain('Cache Read')
  })

  it('expands table borders to the available terminal width by default', () => {
    const rows: ModelReportRow[] = [
      row({ category: 'coding', costUSD: 1.0, inputTokens: 46_300, outputTokens: 3_700_000, cacheWriteTokens: 16_300_000, cacheReadTokens: 1_569_800_000, totalTokens: 1_589_800_000 }),
      row({ category: 'delegation', costUSD: 0.5, inputTokens: 44_200, outputTokens: 1_900_000, cacheWriteTokens: 9_400_000, cacheReadTokens: 499_600_000, totalTokens: 511_000_000 }),
    ]
    const out = renderTable(rows, { byTask: true, showTotals: false, terminalWidth: 132 })
    const lines = out.split('\n')
    expect(visibleWidth(lines[0]!)).toBe(132)
    expect(visibleWidth(lines[1]!)).toBe(132)
    expect(visibleWidth(lines.at(-1)!)).toBe(132)
  })

  it('keeps every colored table row aligned to the same visible width', () => {
    const originalLevel = chalk.level
    chalk.level = 1
    try {
      const rows: ModelReportRow[] = [
        row({ category: 'coding', costUSD: 978.89, inputTokens: 46_300, outputTokens: 3_700_000, cacheWriteTokens: 16_300_000, cacheReadTokens: 1_569_800_000, totalTokens: 1_589_800_000 }),
        row({ category: 'delegation', costUSD: 357.0, inputTokens: 44_200, outputTokens: 1_900_000, cacheWriteTokens: 9_400_000, cacheReadTokens: 499_600_000, totalTokens: 511_000_000 }),
        row({ category: 'exploration', costUSD: 324.86, inputTokens: 96_800, outputTokens: 1_600_000, cacheWriteTokens: 16_600_000, cacheReadTokens: 359_400_000, totalTokens: 377_800_000 }),
      ]
      const out = renderTable(rows, { byTask: true, terminalWidth: 160 })
      const widths = out.split('\n').map(visibleWidth)
      expect(new Set(widths)).toEqual(new Set([160]))
    } finally {
      chalk.level = originalLevel
    }
  })

  it('can render compact tables when fullWidth is disabled', () => {
    const rows: ModelReportRow[] = [
      row({ category: 'coding', costUSD: 1.0, inputTokens: 46_300, outputTokens: 3_700_000, totalTokens: 1_589_800_000 }),
    ]
    const out = renderTable(rows, { byTask: true, showTotals: false, terminalWidth: 160, fullWidth: false })
    expect(visibleWidth(out.split('\n')[0]!)).toBeLessThan(160)
  })

  it('emits a footer totals row by default and suppresses it under showTotals=false', () => {
    const rows: ModelReportRow[] = [row({ costUSD: 1.0, inputTokens: 100, totalTokens: 100 })]
    expect(renderTable(rows, { showTotals: true })).toContain('Total')
    expect(renderTable(rows, { showTotals: false })).not.toMatch(/^\s*Total/m)
  })
})

describe('renderMarkdown', () => {
  it('produces a GitHub-flavored markdown table with right-aligned numeric columns', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 0.6,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        calls: 1,
      },
    ]
    const md = renderMarkdown(rows, { showTotals: false })
    const lines = md.split('\n')
    expect(lines[0]).toBe('| Provider | Model | Top Task | Input | Output | Cache Write | Cache Read | Total | Cost |')
    expect(lines[1]).toBe('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
    expect(lines[2]).toContain('| Claude |')
    expect(lines[2]).toContain('`Sonnet 4.6`')
    expect(lines[2]).toContain('Feature Dev (60%)')
  })

  it('escapes pipe characters in provider/model names', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'odd',
        providerDisplayName: 'A|B',
        model: 'm|n',
        modelDisplayName: 'M|N',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        calls: 0,
      },
    ]
    const md = renderMarkdown(rows, { showTotals: false })
    expect(md).toContain('A\\|B')
    expect(md).toContain('M\\|N')
  })

  it('emits a bold totals row when showTotals is true', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'p',
        providerDisplayName: 'P',
        model: 'm',
        modelDisplayName: 'M',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        calls: 1,
      },
    ]
    const md = renderMarkdown(rows)
    expect(md).toContain('**Total**')
  })
})

describe('renderJson', () => {
  it('emits a JSON array with the documented field shape', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: null,
        topCategory: 'feature',
        topCategoryCost: 6.0,
        topCategoryShare: 0.6,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        calls: 1,
      },
    ]
    const parsed = JSON.parse(renderJson(rows)) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      modelDisplayName: 'Sonnet 4.6',
      topCategory: 'feature',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      calls: 1,
    })
  })
})

describe('renderCsv', () => {
  it('produces a header row followed by one row per ModelReportRow', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 0.6,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        calls: 1,
      },
    ]
    const csv = renderCsv(rows)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('provider,model,top_task,top_task_share,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,total_tokens,calls,cost_usd')
    expect(lines[1]).toBe('Claude,Sonnet 4.6,Feature Dev,0.6000,100,50,0,0,150,1,1.500000')
  })

  it('escapes commas in provider/model cells', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'weird',
        providerDisplayName: 'Weird, Co.',
        model: 'm',
        modelDisplayName: 'M',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 1.0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        calls: 0,
      },
    ]
    const csv = renderCsv(rows)
    expect(csv.split('\n')[1]).toContain('"Weird, Co."')
  })
})
