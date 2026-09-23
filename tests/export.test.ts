import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { exportCsv, exportJson, type PeriodExport } from '../src/export.js'
import type { ProjectSummary } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'export-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeProject(projectPath: string, agentType?: string): ProjectSummary {
  return {
    project: projectPath,
    projectPath,
    sessions: [
      {
        sessionId: 'sess-001',
        project: projectPath,
        agentType,
        firstTimestamp: '2026-04-14T10:00:00Z',
        lastTimestamp: '2026-04-14T10:01:00Z',
        totalCostUSD: 1.23,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        apiCalls: 1,
        turns: [
          {
            userMessage: '=SUM(1,2)',
            timestamp: '2026-04-14T10:00:00Z',
            sessionId: 'sess-001',
            category: 'coding',
            retries: 0,
            hasEdits: true,
            assistantCalls: [
              {
                provider: 'claude',
                model: '+danger-model',
                usage: {
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                },
                costUSD: 1.23,
                tools: ['Read'],
                mcpTools: [],
                skills: [],
                subagentTypes: [],
                hasAgentSpawn: false,
                hasPlanMode: false,
                speed: 'standard',
                timestamp: '2026-04-14T10:00:00Z',
                bashCommands: ['@malicious'],
                deduplicationKey: 'dedup-1',
              },
            ],
          },
        ],
        modelBreakdown: {
          '+danger-model': {
            calls: 1,
            costUSD: 1.23,
            tokens: {
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests: 0,
            },
          },
        },
        toolBreakdown: {
          Read: { calls: 1 },
        },
        mcpBreakdown: {},
        bashBreakdown: {
          '@malicious': { calls: 1 },
        },
        categoryBreakdown: {
          coding: { turns: 1, costUSD: 1.23, retries: 0, editTurns: 1, oneShotTurns: 1 },
          debugging: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          feature: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          refactoring: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          testing: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          exploration: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          planning: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          delegation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          git: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          'build/deploy': { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          conversation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          brainstorming: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
          general: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
        },
        skillBreakdown: {},
      },
    ],
    totalCostUSD: 1.23,
    totalApiCalls: 1,
  }
}

describe('exportCsv', () => {
  it('prefixes formula-like cells to prevent CSV injection', async () => {
    const periods: PeriodExport[] = [
      {
        label: '30 Days',
        projects: [makeProject('=cmd,calc')],
      },
    ]

    const outputPath = join(tmpDir, 'report.csv')
    const folder = await exportCsv(periods, outputPath)
    // exportCsv now writes a folder of clean one-table-per-file CSVs, so the formula-prefix
    // guard is scattered across files. Concatenate them for the assertion surface.
    const [projects, models, shell] = await Promise.all([
      readFile(join(folder, 'projects.csv'), 'utf-8'),
      readFile(join(folder, 'models.csv'), 'utf-8'),
      readFile(join(folder, 'shell-commands.csv'), 'utf-8'),
    ])
    const content = projects + models + shell

    expect(content).toContain("\"'=cmd,calc\"")
    expect(content).toContain("'+danger-model")
    expect(content).toContain("'@malicious")
  })

  it('escapes tab and carriage-return prefixes in CSV cells', async () => {
    const periods: PeriodExport[] = [
      {
        label: '30 Days',
        projects: [makeProject('\tcmd'), makeProject('\rcmd')],
      },
    ]

    const outputPath = join(tmpDir, 'tab-cr.csv')
    const folder = await exportCsv(periods, outputPath)
    const projects = await readFile(join(folder, 'projects.csv'), 'utf-8')
    expect(projects).toContain("'\tcmd")
    expect(projects).toContain("'\rcmd")
  })

  it('includes per-model efficiency metrics', async () => {
    const periods: PeriodExport[] = [
      {
        label: '30 Days',
        projects: [makeProject('app')],
      },
    ]

    const outputPath = join(tmpDir, 'models.csv')
    const folder = await exportCsv(periods, outputPath)
    const models = await readFile(join(folder, 'models.csv'), 'utf-8')

    expect(models).toContain('Edit Turns')
    expect(models).toContain('One-shot Rate (%)')
    expect(models).toContain('Retries/Edit')
    expect(models).toContain('Cost/Edit')
    expect(models).toContain(',1,100,0,')
  })

  it('nests into a dated subfolder when the destination is an existing folder', async () => {
    // The desktop app passes a real folder (e.g. Desktop) with unrelated files in it.
    await writeFile(join(tmpDir, 'unrelated.txt'), 'keep me', 'utf-8')
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [makeProject('app')] }]

    const folder = await exportCsv(periods, tmpDir)

    expect(folder.startsWith(join(tmpDir, 'codeburn-export-'))).toBe(true)
    expect(await readFile(join(tmpDir, 'unrelated.txt'), 'utf-8')).toBe('keep me')
    expect(await readFile(join(folder, 'summary.csv'), 'utf-8')).toContain('Period')
  })

  it('does not crash when periods array is empty', async () => {
    const outputPath = join(tmpDir, 'empty.csv')
    const folder = await exportCsv([], outputPath)
    const entries = await readdir(folder)
    expect(entries.length).toBeGreaterThanOrEqual(0)
  })

  it('describes detail files without hardcoding a 30-day window', async () => {
    const periods: PeriodExport[] = [
      {
        label: '2026-04-07 to 2026-04-10',
        projects: [makeProject('app')],
      },
    ]

    const outputPath = join(tmpDir, 'custom.csv')
    const folder = await exportCsv(periods, outputPath)
    const readme = await readFile(join(folder, 'README.txt'), 'utf-8')

    expect(readme).toContain('selected detail period')
    expect(readme).not.toContain('30-day window')
  })

  it('writes MCP server usage to mcp.csv', async () => {
    const project = makeProject('app')
    project.sessions[0]!.mcpBreakdown = { node_repl: { calls: 5 } }
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [project] }]

    const folder = await exportCsv(periods, join(tmpDir, 'mcp.csv'))
    const mcp = await readFile(join(folder, 'mcp.csv'), 'utf-8')

    expect(mcp).toContain('Server,Calls,Share (%)')
    expect(mcp).toContain('node_repl,5,100')
  })

  it('writes optional subagentType and model fields to per-call records.csv', async () => {
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [makeProject('app', 'planner')] }]

    const folder = await exportCsv(periods, join(tmpDir, 'records.csv'))
    const records = await readFile(join(folder, 'records.csv'), 'utf-8')
    const lines = records.trimEnd().split('\n')

    expect(lines[0]).toContain('subagentType,model')
    expect(lines[1]).toContain('planner')
    expect(lines[1]).toContain("'+danger-model")
  })

  it('keeps supplementary accounting rows in records.csv and marks them', async () => {
    const project = makeProject('app')
    const turn = project.sessions[0]!.turns[0]!
    turn.assistantCalls.push({
      ...turn.assistantCalls[0]!,
      supplementaryAccounting: true,
      costUSD: 0.5,
      deduplicationKey: 'dedup-supp',
    })
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [project] }]

    const folder = await exportCsv(periods, join(tmpDir, 'records.csv'))
    const lines = (await readFile(join(folder, 'records.csv'), 'utf-8')).trimEnd().split('\n')

    // The column exists on every row (undefined on normal ones), so rowsToCsv —
    // which reads headers off the first row — always emits it.
    expect(lines[0]!.endsWith(',supplementary,estimated,unpriced')).toBe(true)
    expect(lines[1]!.endsWith(',1.23,0,,,')).toBe(true)
    expect(lines[2]!.endsWith(',0.5,0,true,,')).toBe(true)
    expect(lines).toHaveLength(3)
  })

  it('counts only behavioral turns in the sessions.csv Turns column', async () => {
    const project = makeProject('app')
    const session = project.sessions[0]!
    session.turns.push({
      ...session.turns[0]!,
      assistantCalls: [{
        ...session.turns[0]!.assistantCalls[0]!,
        supplementaryAccounting: true,
        deduplicationKey: 'dedup-supp',
      }],
    })
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [project] }]

    const folder = await exportCsv(periods, join(tmpDir, 'sessions.csv'))
    const [header, row] = (await readFile(join(folder, 'sessions.csv'), 'utf-8')).split('\n')
    const turns = row!.split(',')[header!.split(',').indexOf('Turns')]

    // Two raw turns, one of them accounting-only.
    expect(turns).toBe('1')
  })

  it('adds optional subagentType and unambiguous model fields to sessions.csv', async () => {
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [makeProject('app', 'planner')] }]

    const folder = await exportCsv(periods, join(tmpDir, 'sessions.csv'))
    const sessions = await readFile(join(folder, 'sessions.csv'), 'utf-8')

    expect(sessions.split('\n')[0]).toBe('Project,Session ID,Started At,Cost (USD),Saved (USD),API Calls,Turns,subagentType,model')
    expect(sessions.split('\n')[1]).toContain('planner')
    expect(sessions.split('\n')[1]).toContain("'+danger-model")
  })
})

describe('exportJson', () => {
  it('reconciles daily rows, records, and summary per call, including a turn with no timestamp', async () => {
    const project = makeProject('app')
    const session = project.sessions[0]!
    const baseTurn = session.turns[0]!
    const baseCall = baseTurn.assistantCalls[0]!
    const at = (d: number, h: number, m: number) => new Date(2026, 3, d, h, m).toISOString()
    session.turns = [
      { ...baseTurn, timestamp: '', assistantCalls: [{ ...baseCall, timestamp: at(14, 10, 0), costUSD: 1.23 }] },
      {
        ...baseTurn,
        timestamp: at(14, 23, 59),
        assistantCalls: [
          { ...baseCall, timestamp: at(14, 23, 59), costUSD: 0.004, deduplicationKey: 'late' },
          { ...baseCall, timestamp: at(15, 0, 1), costUSD: 2.006, deduplicationKey: 'after-midnight' },
        ],
      },
    ]
    session.totalCostUSD = 3.24
    project.totalCostUSD = 3.24

    const saved = await exportJson([{ label: '30 Days', projects: [project] }], join(tmpDir, 'reconcile.json'))
    const data = JSON.parse(await readFile(saved, 'utf-8'))

    const daily = data.periods[0].daily as Array<Record<string, number | string>>
    expect(daily.map(d => [d.Date, d['Cost (USD)']])).toEqual([['2026-04-14', 1.23], ['2026-04-15', 2.01]])
    const dailySum = daily.reduce((s, d) => s + (d['Cost (USD)'] as number), 0)
    const recordSum = (data.records as Array<{ cost: number }>).reduce((s, r) => s + r.cost, 0)
    expect(dailySum).toBeCloseTo(data.summary[0]['Cost (USD)'], 10)
    expect(recordSum).toBeCloseTo(data.summary[0]['Cost (USD)'], 10)
    expect(data.records[1].cost).toBe(0.004)
  })

  it('adds per-call records with optional subagentType and model fields', async () => {
    const periods: PeriodExport[] = [{
      label: '30 Days',
      projects: [makeProject('agent-project', 'planner'), makeProject('main-project')],
    }]

    const outputPath = join(tmpDir, 'records.json')
    const saved = await exportJson(periods, outputPath)
    const data = JSON.parse(await readFile(saved, 'utf-8'))

    expect(data.records[0]).toMatchObject({
      project: 'agent-project',
      subagentType: 'planner',
      model: '+danger-model',
      inputTokens: 100,
      outputTokens: 50,
      cost: 1.23,
    })
    expect(data.records[1]).toMatchObject({ project: 'main-project', model: '+danger-model' })
    expect(data.records[1]).not.toHaveProperty('subagentType')
    expect(data.sessions[0]).toMatchObject({ subagentType: 'planner', model: '+danger-model' })
    expect(data.sessions[1]).toMatchObject({ model: '+danger-model' })
    expect(data.sessions[1]).not.toHaveProperty('subagentType')
  })

  it('keeps supplementary-accounting tokens/cost in daily rows without counting them as calls', async () => {
    const project = makeProject('app')
    const turn = project.sessions[0]!.turns[0]!
    turn.assistantCalls.push({
      ...turn.assistantCalls[0]!,
      supplementaryAccounting: true,
      usage: { ...turn.assistantCalls[0]!.usage, inputTokens: 40, outputTokens: 0, cacheReadInputTokens: 900 },
      costUSD: 0.5,
      deduplicationKey: 'dedup-supp',
    })
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [project] }]

    const saved = await exportJson(periods, join(tmpDir, 'supp.json'))
    const data = JSON.parse(await readFile(saved, 'utf-8'))

    expect(data.periods[0].daily).toHaveLength(1)
    expect(data.periods[0].daily[0]).toMatchObject({
      'API Calls': 1,
      'Input Tokens': 140,
      'Cache Read Tokens': 900,
      'Cost (USD)': 1.73,
    })
  })

  it('marks supplementary records and omits the key on normal ones', async () => {
    const project = makeProject('app')
    const turn = project.sessions[0]!.turns[0]!
    turn.assistantCalls.push({
      ...turn.assistantCalls[0]!,
      supplementaryAccounting: true,
      costUSD: 0.5,
      deduplicationKey: 'dedup-supp',
    })
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [project] }]

    const saved = await exportJson(periods, join(tmpDir, 'supp-records.json'))
    const data = JSON.parse(await readFile(saved, 'utf-8'))

    expect(data.records).toHaveLength(2)
    expect(data.records[0]).not.toHaveProperty('supplementary')
    expect(data.records[1]).toMatchObject({ supplementary: true, cost: 0.5 })
  })

  it('writes a dated file inside the folder when the destination is an existing folder', async () => {
    // The desktop app passes the folder the user picked; `${dir}.json` wrote a sibling of it.
    await writeFile(join(tmpDir, 'unrelated.txt'), 'keep me', 'utf-8')
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [makeProject('app')] }]

    const saved = await exportJson(periods, tmpDir)

    expect(saved.startsWith(join(tmpDir, 'codeburn-export-'))).toBe(true)
    expect(saved.endsWith('.json')).toBe(true)
    expect(JSON.parse(await readFile(saved, 'utf-8')).schema).toBe('codeburn.export.v2')
    expect(await readFile(join(tmpDir, 'unrelated.txt'), 'utf-8')).toBe('keep me')
  })

  it('creates a folder named with a trailing separator and writes inside it', async () => {
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [makeProject('app')] }]
    const folder = join(tmpDir, 'new-exports')

    const saved = await exportJson(periods, `${folder}/`)

    expect(saved.startsWith(join(folder, 'codeburn-export-'))).toBe(true)
    expect(JSON.parse(await readFile(saved, 'utf-8')).schema).toBe('codeburn.export.v2')
  })

  it('still appends .json to a destination that is not a folder', async () => {
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [makeProject('app')] }]
    const saved = await exportJson(periods, join(tmpDir, 'report'))
    expect(saved).toBe(join(tmpDir, 'report.json'))
  })

  it('still refuses to overwrite a file inside the folder that is not a codeburn export', async () => {
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [makeProject('app')] }]
    const saved = await exportJson(periods, tmpDir)
    await writeFile(saved, '{"schema": "something.else"}', 'utf-8')
    await expect(exportJson(periods, tmpDir)).rejects.toThrow(/Refusing to overwrite/)
  })

  it('includes an mcp section with per-server usage', async () => {
    const project = makeProject('app')
    project.sessions[0]!.mcpBreakdown = { node_repl: { calls: 3 }, github: { calls: 1 } }
    const periods: PeriodExport[] = [{ label: '30 Days', projects: [project] }]

    const outputPath = join(tmpDir, 'export.json')
    const saved = await exportJson(periods, outputPath)
    const data = JSON.parse(await readFile(saved, 'utf-8'))

    expect(Array.isArray(data.mcp)).toBe(true)
    expect(data.mcp).toEqual([
      { Server: 'node_repl', Calls: 3, 'Share (%)': 75 },
      { Server: 'github', Calls: 1, 'Share (%)': 25 },
    ])
  })
})
