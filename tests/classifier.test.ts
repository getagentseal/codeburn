import { describe, it, expect } from 'vitest'

import { classifyTurn } from '../src/classifier.js'
import type { ParsedApiCall, ParsedTurn } from '../src/types.js'

function makeCall(opts: Partial<ParsedApiCall> & { tools?: string[]; skills?: string[] }): ParsedApiCall {
  const tools = opts.tools ?? []
  return {
    provider: 'claude',
    model: 'Opus 4.7',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0,
    tools,
    mcpTools: tools.filter(t => t.startsWith('mcp__')),
    skills: opts.skills ?? [],
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: 'standard',
    timestamp: '2026-05-04T00:00:00Z',
    bashCommands: [],
    deduplicationKey: 'k',
    ...opts,
  }
}

function makeTurn(calls: ParsedApiCall[], userMessage = ''): ParsedTurn {
  return {
    userMessage,
    assistantCalls: calls,
    timestamp: '2026-05-04T00:00:00Z',
    sessionId: 's1',
  }
}

describe('classifyTurn — Skill subCategory', () => {
  it('attaches subCategory when a Skill tool fires alone (input.skill)', () => {
    const turn = makeTurn([makeCall({ tools: ['Skill'], skills: ['init'] })])
    const c = classifyTurn(turn)
    expect(c.category).toBe('general')
    expect(c.subCategory).toBe('init')
  })

  it('attaches subCategory when skill identifier comes via input.name (extracted upstream)', () => {
    const turn = makeTurn([makeCall({ tools: ['Skill'], skills: ['atelier'] })])
    const c = classifyTurn(turn)
    expect(c.category).toBe('general')
    expect(c.subCategory).toBe('atelier')
  })

  it('uses the first skill identifier when a single turn invokes multiple skills', () => {
    const turn = makeTurn([makeCall({ tools: ['Skill', 'Skill'], skills: ['review', 'security-review'] })])
    const c = classifyTurn(turn)
    expect(c.category).toBe('general')
    expect(c.subCategory).toBe('review')
  })

  it('aggregates skills across multiple assistant calls in the same turn', () => {
    const turn = makeTurn([
      makeCall({ tools: ['Skill'], skills: ['claude-api'] }),
      makeCall({ tools: ['Skill'], skills: ['init'] }),
    ])
    const c = classifyTurn(turn)
    expect(c.category).toBe('general')
    expect(c.subCategory).toBe('claude-api')
  })

  it('does not attach subCategory when the Skill tool fires but no skill name was extracted', () => {
    const turn = makeTurn([makeCall({ tools: ['Skill'], skills: [] })])
    const c = classifyTurn(turn)
    expect(c.category).toBe('general')
    expect(c.subCategory).toBeUndefined()
  })

  it('does not attach subCategory when category is not general (e.g. Skill alongside Edit promotes to coding)', () => {
    const turn = makeTurn([makeCall({ tools: ['Skill', 'Edit'], skills: ['init'] })])
    const c = classifyTurn(turn)
    expect(c.category).toBe('coding')
    expect(c.subCategory).toBeUndefined()
  })

  it('does not attach subCategory for non-Skill general turns', () => {
    const turn = makeTurn([makeCall({ tools: [] })], 'just chatting')
    const c = classifyTurn(turn)
    expect(c.subCategory).toBeUndefined()
  })

  it('tolerates missing skills field on legacy ParsedApiCall shape', () => {
    const baseCall = makeCall({ tools: ['Skill'], skills: ['init'] })
    const legacyCall = { ...baseCall } as unknown as ParsedApiCall & { skills?: string[] }
    delete (legacyCall as { skills?: string[] }).skills
    const c = classifyTurn(makeTurn([legacyCall]))
    expect(c.category).toBe('general')
    expect(c.subCategory).toBeUndefined()
  })
})

describe('classifyTurn — feature prompts with debug-like words', () => {
  it('classifies new error handling as feature work, not debugging', () => {
    const turn = makeTurn([makeCall({ tools: ['Edit'] })], 'add error handling to the import flow')
    expect(classifyTurn(turn).category).toBe('feature')
  })

  it('classifies issue tracker creation as feature work', () => {
    const turn = makeTurn([makeCall({ tools: ['Edit'] })], 'create an issue tracker dashboard')
    expect(classifyTurn(turn).category).toBe('feature')
  })

  it('classifies layout work for a new feature as feature work even when the prompt says fix', () => {
    const turn = makeTurn([makeCall({ tools: ['Edit'] })], 'fix the layout for the new feature panel')
    expect(classifyTurn(turn).category).toBe('feature')
  })

  it('keeps explicit bug fixes classified as debugging', () => {
    const turn = makeTurn([makeCall({ tools: ['Edit'] })], 'fix the login bug in auth')
    expect(classifyTurn(turn).category).toBe('debugging')
  })

  it('keeps explicit failures in new features classified as debugging', () => {
    const turn = makeTurn([makeCall({ tools: ['Edit'] })], 'fix the 500 error in the new feature')
    expect(classifyTurn(turn).category).toBe('debugging')
  })

  it('applies the same feature-context rule to conversation-only turns', () => {
    const turn = makeTurn([], 'create an issue tracker')
    expect(classifyTurn(turn).category).toBe('feature')
  })
})
