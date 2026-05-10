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

// Regression coverage for issue #196: feature verbs that lead a message
// were previously hijacked into 'debugging' just because the message contained
// an incidental "error" / "fix" / "issue" word later in the same sentence.
// Now whichever keyword pattern matches earliest wins.
describe('classifyTurn — feature vs debugging precedence (#196)', () => {
  function codingTurn(userMessage: string): ParsedTurn {
    return makeTurn([makeCall({ tools: ['Edit'] })], userMessage)
  }

  it('classifies "add error handling" as feature, not debugging', () => {
    const c = classifyTurn(codingTurn('add error handling to the auth module'))
    expect(c.category).toBe('feature')
  })

  it('classifies "create an issue tracker" as feature, not debugging', () => {
    const c = classifyTurn(codingTurn('create an issue tracker page in the dashboard'))
    expect(c.category).toBe('feature')
  })

  it('classifies "implement the 404 page" as feature, not debugging', () => {
    const c = classifyTurn(codingTurn('implement the 404 page with a friendly redirect'))
    expect(c.category).toBe('feature')
  })

  it('still classifies "fix the layout for the new feature" as debugging', () => {
    const c = classifyTurn(codingTurn('fix the layout for the new feature'))
    expect(c.category).toBe('debugging')
  })

  it('still classifies a plain bug report as debugging', () => {
    const c = classifyTurn(codingTurn('login is broken, traceback below'))
    expect(c.category).toBe('debugging')
  })

  it('classifies "refactor the error handling" as refactoring', () => {
    const c = classifyTurn(codingTurn('refactor the error handling so it is cleaner'))
    expect(c.category).toBe('refactoring')
  })

  it('chat-only message starting with "add" stays feature even with "fix" later', () => {
    const c = classifyTurn(makeTurn([], 'add a setting page; we will fix the styles after'))
    expect(c.category).toBe('feature')
  })

  it('chat-only message starting with "fix" stays debugging even with "add" later', () => {
    const c = classifyTurn(makeTurn([], 'fix the bug introduced when we added the new flag'))
    expect(c.category).toBe('debugging')
  })
})
