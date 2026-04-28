import { describe, it, expect } from 'vitest'
import { providers, getAllProviders } from '../src/providers/index.js'

describe('provider registry', () => {
  it('has core providers registered synchronously', () => {
    expect(providers.map(p => p.name)).toEqual(['claude', 'codex', 'copilot', 'gemini', 'kiro', 'pi', 'omp'])
  })

  it('includes sqlite providers after async load', async () => {
    const all = await getAllProviders()
    const names = all.map(p => p.name)
    expect(names).toContain('claude')
    expect(names).toContain('codex')
    expect(names.length).toBeGreaterThanOrEqual(2)
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
  })

  it('claude model display names are human-readable', () => {
    const claude = providers.find(p => p.name === 'claude')!
    expect(claude.modelDisplayName('claude-opus-4-6-20260205')).toBe('Opus 4.6')
    expect(claude.modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })

  it('cursor model display names handle auto mode', async () => {
    const all = await getAllProviders()
    const cursor = all.find(p => p.name === 'cursor')!
    expect(cursor.modelDisplayName('cursor-auto')).toBe('Cursor (auto)')
    expect(cursor.modelDisplayName('claude-4.5-opus-high-thinking')).toBe('Opus 4.5 (Thinking)')
    expect(cursor.modelDisplayName('grok-code-fast-1')).toBe('Grok Code Fast')
    expect(cursor.modelDisplayName('unknown-model')).toBe('unknown-model')
  })
})
