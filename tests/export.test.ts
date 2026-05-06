import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { exportCsv, type PeriodExport } from '../src/export.js'
import type { ProjectSummary } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'export-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeProject(projectPath: string): ProjectSummary {
  return {
    project: projectPath,
    projectPath,
    sessions: [
      {
        sessionId: 'sess-001',
        project: projectPath,
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
})
