import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import { cardDataFromPayload, renderCard, type CardData } from '../src/card.js'
import type { MenubarPayload } from '../src/menubar-json.js'
import { noonTz, utcDaysAgo } from './fixtures/clock.js'

vi.setConfig({ testTimeout: 30_000 })

const base: CardData = {
  period: 'month',
  tools: [
    { name: 'claude', cost: 1456.56 },
    { name: 'cursor-agent', cost: 0.19 },
    { name: 'devin', cost: 0.18 },
  ],
  daily: [0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 443, 300, 390, 200],
  cost: 1456.93,
  calls: 20269,
  cacheHitPercent: 99.8,
}

function texts(svg: string): string[] {
  return [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ''))
}

describe('renderCard', () => {
  it('renders header, one row per tool, sparkline, totals and footer', () => {
    const svg = renderCard(base, 'auto')
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    const t = texts(svg)
    expect(t[0]).toBe('ai.agents@month · top 3 ')
    expect(t).toContain(' claude')
    expect(t).toContain(' cursor-agent')
    expect(t).toContain('$1,456.56')
    expect(t).toContain('$0.190')
    expect(t).toContain(' last 14 days ')
    expect(t).toContain(' peak $443/day')
    expect(t).toContain('$1,457 API-equiv · 20,269 calls · ')
    expect(t).toContain('99.8% cache hit')
    expect(t).toContain('tracked by CodeBurn')
    expect(svg).not.toMatch(/href|url\(|@import|<image/)
    expect(renderCard(base, 'auto')).toBe(svg)
  })

  it('auto follows prefers-color-scheme, light and dark are fixed', () => {
    expect(renderCard(base, 'auto')).toContain('@media (prefers-color-scheme: dark)')
    const light = renderCard(base, 'light')
    const dark = renderCard(base, 'dark')
    expect(light).not.toContain('@media')
    expect(dark).not.toContain('@media')
    expect(light).toContain('.v{fill:#1f2328}')
    expect(dark).toContain('.v{fill:#e8e6e1}')
  })

  it('renders a friendly empty card', () => {
    const svg = renderCard({ ...base, tools: [], daily: Array(14).fill(0), cost: 0, calls: 0, cacheHitPercent: null }, 'auto')
    const t = texts(svg)
    expect(t[0]).toBe('ai.agents@month ')
    expect(t).toContain(' no AI agent usage recorded for this period yet')
    expect(svg).not.toContain('API-equiv')
    expect(svg).not.toContain('NaN')
  })

  it('sizes the label column to the longest name so bars never overlap labels', () => {
    const long = 'a-really-long-tool-name-that-goes-on'
    const svg = renderCard({ ...base, tools: [{ name: long, cost: 5 }, { name: 'x', cost: 1 }] }, 'auto')
    const row = svg.split('\n').find(l => l.includes('a-really'))!
    const [labelX, barX] = [...row.matchAll(/x="([\d.]+)"/g)].map(m => Number(m[1]))
    const label = texts(row)[0]!
    expect(label.length).toBeLessThanOrEqual(25)
    expect(label.endsWith('…')).toBe(true)
    expect(barX! - labelX!).toBeGreaterThan(label.length * 7.4)
    const width = Number(svg.match(/width="(\d+)"/)![1])
    const costX = [...row.matchAll(/x="([\d.]+)"/g)].map(m => Number(m[1]))[2]!
    expect(width).toBeGreaterThan(costX + '$5.00'.length * 7.4)
  })

  it('handles one tool, big numbers and missing cache data', () => {
    const svg = renderCard({ ...base, tools: [{ name: 'codex', cost: 1234567.891 }], cost: 1234567.891, calls: 9876543, cacheHitPercent: null }, 'dark')
    const t = texts(svg)
    expect(t[0]).toBe('ai.agents@month · top 1 ')
    expect(t).toContain('$1,234,567.89')
    expect(t).toContain('$1,234,568 API-equiv · 9,876,543 calls')
    expect(svg).not.toContain('cache hit')
  })

  it('escapes every text', () => {
    const svg = renderCard({ ...base, period: '<p>', tools: [{ name: '<script>&"\'', cost: 1 }] }, 'auto')
    expect(svg).not.toContain('<script>')
    expect(svg).not.toContain('<p>')
    expect(svg).toContain('&lt;script&gt;&amp;&quot;&#39;')
  })
})

describe('cardDataFromPayload', () => {
  it('keeps counted tools with usage, fills 14 days, and carries nothing project-level', () => {
    const payload = {
      current: {
        cost: 10, calls: 7, inputTokens: 100, cacheReadTokens: 900, cacheHitPercent: 90,
        providerDetails: [
          { id: 'codex', label: 'Codex', cost: 2, calls: 3, hasUsage: true },
          { id: 'claude', label: 'Claude', cost: 8, calls: 4, hasUsage: true },
          { id: 'gemini', label: 'Gemini', cost: 0, calls: 0, hasUsage: false },
          { id: 'vercel-gateway', label: 'Vercel', cost: 50, calls: 1, hasUsage: true, excludedFromTotal: true },
        ],
        topProjects: [{ name: 'secret-proj', path: '/Users/me/secret-proj', cost: 10 }],
        topSessions: [{ sessionId: 'sess-secret', project: 'secret-proj', cost: 10 }],
      },
      history: { daily: [{ date: '2026-10-05', cost: 4 }, { date: '2026-09-22', cost: 1 }, { date: '2026-09-01', cost: 99 }] },
    } as unknown as MenubarPayload
    const data = cardDataFromPayload(payload, 'month', new Date(2026, 9, 5, 12), 3)
    expect(data.tools).toEqual([{ name: 'claude', cost: 8 }, { name: 'codex', cost: 2 }])
    expect(data.daily).toHaveLength(14)
    expect(data.daily[0]).toBe(1)
    expect(data.daily[13]).toBe(4)
    expect(data.daily.reduce((a, b) => a + b, 0)).toBe(5)
    expect(data.cacheHitPercent).toBe(90)
    expect(JSON.stringify(data)).not.toMatch(/secret|\/Users/)
  })

  it('reports no cache data when there are no input or cache-read tokens', () => {
    const payload = {
      current: { cost: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheHitPercent: 0, providerDetails: [] },
      history: { daily: [] },
    } as unknown as MenubarPayload
    expect(cardDataFromPayload(payload, 'week', new Date(), 3).cacheHitPercent).toBeNull()
  })
})

describe('codeburn card CLI', () => {
  it('writes an SVG without project names or paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-card-'))
    try {
      const secret = 'zz-secret-client-project'
      const cwd = `/Users/someone/${secret}`
      const projectDir = join(home, '.claude', 'projects', `-Users-someone-${secret}`)
      await mkdir(projectDir, { recursive: true })
      const day = utcDaysAgo(2)
      await writeFile(join(projectDir, 'sess-zz-secret.jsonl'), [
        JSON.stringify({ type: 'user', sessionId: 'sess-zz-secret', cwd, timestamp: `${day}T09:00:00Z`, message: { role: 'user', content: `fix ${secret}` } }),
        JSON.stringify({
          type: 'assistant', sessionId: 'sess-zz-secret', cwd, timestamp: `${day}T09:01:00Z`,
          message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000, output_tokens: 100 } },
        }),
      ].join('\n'))
      const out = join(home, 'assets', 'card.svg')
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'card', '-p', '30days', '--out', out], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude'), HOME: home, USERPROFILE: home, TZ: noonTz(), CODEBURN_CACHE_DIR: join(home, 'cache') },
        encoding: 'utf-8',
      })
      expect(result.status, result.stderr).toBe(0)
      const svg = await readFile(out, 'utf-8')
      expect(svg).toContain(' claude')
      expect(svg).toMatch(/· 1 call(?!s)/)
      expect(svg).not.toContain(secret)
      expect(svg).not.toContain('/Users/')
      expect(svg).not.toContain('sess-zz')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
