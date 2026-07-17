import { describe, it, expect, vi } from 'vitest'
import { providers, getAllProviders, getProvider, safeDiscoverSessions, discoverAllSessions } from '../src/providers/index.js'
import type { Provider } from '../src/providers/types.js'

function fakeProvider(name: string, discover: Provider['discoverSessions']): Provider {
  return {
    name,
    displayName: name,
    modelDisplayName: (m: string) => m,
    toolDisplayName: (t: string) => t,
    discoverSessions: discover,
  } as unknown as Provider
}

describe('provider registry', () => {
  it('has core providers registered synchronously', () => {
    expect(providers.map(p => p.name)).toEqual(['claude', 'cline', 'codewhale', 'codebuff', 'codex', 'copilot', 'devin', 'droid', 'gemini', 'hermes', 'ibm-bob', 'kilo-code', 'kiro', 'kimi', 'lingtai-tui', 'mistral-vibe', 'mux', 'openclaw', 'open-design', 'pi', 'omp', 'qwen', 'quickdesk', 'roo-code', 'zerostack', 'grok'])
  })

  it('codebuff tool display names normalize codebuff-native names to canonical set', () => {
    const codebuff = providers.find(p => p.name === 'codebuff')!
    expect(codebuff.toolDisplayName('read_files')).toBe('Read')
    expect(codebuff.toolDisplayName('code_search')).toBe('Grep')
    expect(codebuff.toolDisplayName('str_replace')).toBe('Edit')
    expect(codebuff.toolDisplayName('run_terminal_command')).toBe('Bash')
    expect(codebuff.toolDisplayName('spawn_agents')).toBe('Agent')
    expect(codebuff.toolDisplayName('write_todos')).toBe('TodoWrite')
    expect(codebuff.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })

  it('codebuff model display names cover known agent tiers', () => {
    const codebuff = providers.find(p => p.name === 'codebuff')!
    expect(codebuff.modelDisplayName('codebuff')).toBe('Codebuff')
    expect(codebuff.modelDisplayName('codebuff-base2')).toBe('Codebuff Base 2')
    expect(codebuff.modelDisplayName('some-future-model')).toBe('some-future-model')
  })

  it('includes sqlite providers after async load', async () => {
    const all = await getAllProviders()
    const names = all.map(p => p.name)
    expect(names).toContain('claude')
    expect(names).toContain('codex')
    expect(names).toContain('forge')
    expect(names).toContain('warp')
    expect(names.length).toBeGreaterThanOrEqual(2)
  })

  it('forge is available through async provider loading', async () => {
    const forge = await getProvider('forge')
    expect(forge).toBeDefined()
    expect(forge!.name).toBe('forge')
  })

  it('warp model and tool display names are normalized', async () => {
    const warp = await getProvider('warp')
    expect(warp).toBeDefined()
    expect(warp!.modelDisplayName('warp-auto-efficient')).toBe('Warp Auto (efficient)')
    expect(warp!.modelDisplayName('gpt-5.3-codex')).toBe('GPT-5.3 Codex')
    expect(warp!.toolDisplayName('run_command')).toBe('Bash')
  })

  it('opencode model display names strip provider prefix', async () => {
    const all = await getAllProviders()
    const oc = all.find(p => p.name === 'opencode')
    if (!oc) return
    expect(oc.modelDisplayName('anthropic/claude-opus-4-6-20260205')).toBe('Opus 4.6')
    expect(oc.modelDisplayName('google/gemini-2.5-pro')).toBe('Gemini 2.5 Pro')
  })

  it('opencode tool display names normalize builtins', async () => {
    const all = await getAllProviders()
    const oc = all.find(p => p.name === 'opencode')
    if (!oc) return
    expect(oc.toolDisplayName('bash')).toBe('Bash')
    expect(oc.toolDisplayName('edit')).toBe('Edit')
    expect(oc.toolDisplayName('task')).toBe('Agent')
    expect(oc.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })

  it('claude tool display names are identity', () => {
    const claude = providers.find(p => p.name === 'claude')!
    expect(claude.toolDisplayName('Bash')).toBe('Bash')
    expect(claude.toolDisplayName('Read')).toBe('Read')
  })

  it('codex tool display names are normalized', () => {
    const codex = providers.find(p => p.name === 'codex')!
    expect(codex.toolDisplayName('exec_command')).toBe('Bash')
    expect(codex.toolDisplayName('read_file')).toBe('Read')
    expect(codex.toolDisplayName('write_file')).toBe('Edit')
    expect(codex.toolDisplayName('spawn_agent')).toBe('Agent')
  })

  it('codex model display names are human-readable', () => {
    const codex = providers.find(p => p.name === 'codex')!
    expect(codex.modelDisplayName('gpt-5.4')).toBe('GPT-5.4')
    expect(codex.modelDisplayName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
    expect(codex.modelDisplayName('gpt-5.3-codex')).toBe('GPT-5.3 Codex')
    expect(codex.modelDisplayName('gpt-5.5')).toBe('GPT-5.5')
  })

  it('claude model display names are human-readable', () => {
    const claude = providers.find(p => p.name === 'claude')!
    expect(claude.modelDisplayName('claude-opus-4-6-20260205')).toBe('Opus 4.6')
    expect(claude.modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })

  it('kimi model and tool display names are normalized', () => {
    const kimi = providers.find(p => p.name === 'kimi')!
    expect(kimi.modelDisplayName('kimi-auto')).toBe('Kimi (auto)')
    expect(kimi.modelDisplayName('kimi-k2-thinking-turbo')).toBe('Kimi K2 Thinking Turbo')
    expect(kimi.toolDisplayName('Shell')).toBe('Bash')
    expect(kimi.toolDisplayName('WriteFile')).toBe('Write')
  })

  it('lingtai-tui model display names are normalized', () => {
    const lingtai = providers.find(p => p.name === 'lingtai-tui')!
    expect(lingtai.displayName).toBe('LingTai TUI')
    expect(lingtai.modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(lingtai.toolDisplayName('custom_tool')).toBe('custom_tool')
  })

  it('cursor model display names handle auto mode', async () => {
    const all = await getAllProviders()
    const cursor = all.find(p => p.name === 'cursor')!
    expect(cursor.modelDisplayName('cursor-auto')).toBe('Cursor (auto)')
    expect(cursor.modelDisplayName('claude-4.5-opus-high-thinking')).toBe('Opus 4.5 (Thinking)')
    expect(cursor.modelDisplayName('grok-code-fast-1')).toBe('Grok Code Fast')
    expect(cursor.modelDisplayName('unknown-model')).toBe('unknown-model')
  })

  describe('provider-discovery isolation', () => {
    it('safeDiscoverSessions returns [] and warns once instead of propagating', async () => {
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      const boom = fakeProvider('boom-helper', async () => { throw new Error('crafted file blew up') })
      try {
        await expect(safeDiscoverSessions(boom)).resolves.toEqual([])
        expect(warn.mock.calls.length).toBeGreaterThanOrEqual(1)
        expect(String(warn.mock.calls[0]![0])).toContain('boom-helper')
        // Deduped on repeat within the same run: no additional warning.
        const afterFirst = warn.mock.calls.length
        await safeDiscoverSessions(boom)
        expect(warn.mock.calls.length).toBe(afterFirst)
      } finally {
        warn.mockRestore()
      }
    })

    it('discoverAllSessions drops a throwing provider but keeps the healthy ones', async () => {
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      const boom = fakeProvider('boom-loop', async () => { throw new Error('kaboom') })
      const ok1 = fakeProvider('ok1', async () => [{ path: '/a.jsonl', project: 'p1', provider: 'ok1' }])
      const ok2 = fakeProvider('ok2', async () => [{ path: '/b.jsonl', project: 'p2', provider: 'ok2' }])
      try {
        // A throwing provider in the middle must not abort the loop.
        const sources = await discoverAllSessions('all', [ok1, boom, ok2])
        expect(sources.map(s => s.path)).toEqual(['/a.jsonl', '/b.jsonl'])
        expect(warn.mock.calls.some(c => String(c[0]).includes('boom-loop'))).toBe(true)
      } finally {
        warn.mockRestore()
      }
    })

    it('discoverAllSessions honors the provider filter', async () => {
      const ok1 = fakeProvider('keep', async () => [{ path: '/keep.jsonl', project: 'k', provider: 'keep' }])
      const ok2 = fakeProvider('drop', async () => [{ path: '/drop.jsonl', project: 'd', provider: 'drop' }])
      const sources = await discoverAllSessions('keep', [ok1, ok2])
      expect(sources.map(s => s.path)).toEqual(['/keep.jsonl'])
    })
  })
})
