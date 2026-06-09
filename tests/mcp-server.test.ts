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

async function connect(aggregate: (p: unknown, o: unknown) => Promise<MenubarPayload>) {
  const server = createServer({ version: 'test', aggregate: aggregate as never })
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
    const res = await client.callTool({ name: 'get_usage', arguments: { period: 'today', by: 'project' } })
    expect(JSON.stringify(res)).not.toContain('real-repo')
    expect(JSON.stringify(res)).toMatch(/project-[0-9a-f]{6}/)
    expect(res.isError).toBeFalsy()
  })
  it('get_usage reveals names when opted in', async () => {
    const client = await connect(async () => fakePayload())
    const res = await client.callTool({ name: 'get_usage', arguments: { period: 'today', by: 'project', include_project_names: true } })
    expect(JSON.stringify(res)).toContain('real-repo')
  })
  it('empty data returns a friendly message, not a zero table', async () => {
    const client = await connect(async () => fakePayload(0))
    const res = await client.callTool({ name: 'get_usage', arguments: { period: 'today' } })
    expect(String((res.content as Array<{ text: string }>)[0].text).toLowerCase()).toContain('no usage')
  })
  it('aggregator failure surfaces as isError', async () => {
    const client = await connect(async () => { throw new Error('boom') })
    const res = await client.callTool({ name: 'get_savings', arguments: {} })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).toContain('boom')
  })
})
