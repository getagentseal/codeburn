import { describe, it, expect } from 'vitest'
import { providers } from '../src/providers/index.js'

describe('provider registry', () => {
  it('has claude, codex, and opencode providers', () => {
    expect(providers.map(p => p.name)).toEqual(['claude', 'codex', 'opencode'])
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
})
