import { describe, it, expect } from 'vitest'

import {
  countStructuredPatchLoc,
  collectToolResultMeta,
  collectSessionMeta,
  emptySessionMeta,
  parseApiCall,
  groupIntoTurns,
  parsedTurnsToCachedTurns,
  type ToolResultMeta,
} from '../src/parser.js'
import type { JournalEntry } from '../src/types.js'

// ── structuredPatch LOC counting ───────────────────────────────────────

describe('countStructuredPatchLoc', () => {
  it('counts +/- lines across a single hunk', () => {
    const patch = [
      { oldStart: 80, oldLines: 7, newStart: 80, newLines: 7, lines: [
        '     unchanged context',
        '-    old line',
        '+    new line',
        '       more context',
      ] },
    ]
    expect(countStructuredPatchLoc(patch)).toEqual({ added: 1, removed: 1 })
  })

  it('sums across multiple hunks', () => {
    const patch = [
      { lines: ['+a', '+b', '-c', ' ctx'] },
      { lines: ['+d', '-e', '-f'] },
    ]
    expect(countStructuredPatchLoc(patch)).toEqual({ added: 3, removed: 3 })
  })

  it('returns zero for an empty patch (Write-create shape)', () => {
    expect(countStructuredPatchLoc([])).toEqual({ added: 0, removed: 0 })
  })

  it('returns zero for a missing/non-array patch', () => {
    expect(countStructuredPatchLoc(undefined)).toEqual({ added: 0, removed: 0 })
    expect(countStructuredPatchLoc(null)).toEqual({ added: 0, removed: 0 })
    expect(countStructuredPatchLoc({ lines: ['+x'] })).toEqual({ added: 0, removed: 0 })
  })

  it('ignores hunks whose lines are absent or non-string', () => {
    const patch = [{ oldStart: 1 }, { lines: [1, '+ok', null, '-no'] }]
    expect(countStructuredPatchLoc(patch)).toEqual({ added: 1, removed: 1 })
  })
})

// ── tool-result meta extraction + per-call attribution ─────────────────

function assistantEntry(id: string, toolUseIds: string[]): JournalEntry {
  return {
    type: 'assistant',
    timestamp: '2026-07-01T10:00:00Z',
    sessionId: 's1',
    gitBranch: 'main',
    message: {
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      id,
      content: toolUseIds.map(tid => ({ type: 'tool_use' as const, id: tid, name: 'Edit', input: {} })),
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }
}

function toolResultEntry(opts: {
  toolUseId: string
  isError?: boolean
  structuredPatch?: unknown
  interrupted?: boolean
  userModified?: boolean
}): JournalEntry {
  return {
    type: 'user',
    timestamp: '2026-07-01T10:00:01Z',
    sessionId: 's1',
    gitBranch: 'main',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: opts.toolUseId, is_error: opts.isError, content: 'x' } as never],
    },
    toolUseResult: {
      structuredPatch: opts.structuredPatch,
      interrupted: opts.interrupted ?? false,
      userModified: opts.userModified ?? false,
    },
  } as JournalEntry
}

describe('collectToolResultMeta + parseApiCall attribution', () => {
  it('attributes LOC, interrupted, userModified, and toolErrors to the issuing call', () => {
    const map = new Map<string, ToolResultMeta>()
    collectToolResultMeta(toolResultEntry({
      toolUseId: 'tu1',
      structuredPatch: [{ lines: ['+a', '+b', '-c'] }],
      userModified: true,
    }), map)
    collectToolResultMeta(toolResultEntry({
      toolUseId: 'tu2',
      isError: true,
      interrupted: true,
    }), map)

    const call = parseApiCall(assistantEntry('m1', ['tu1', 'tu2']), map)
    expect(call).not.toBeNull()
    expect(call!.locAdded).toBe(2)
    expect(call!.locRemoved).toBe(1)
    expect(call!.toolErrors).toBe(1)
    expect(call!.interrupted).toBe(true)
    expect(call!.userModified).toBe(true)
  })

  it('omits all rich fields when no meta map is supplied', () => {
    const call = parseApiCall(assistantEntry('m1', ['tu1']))
    expect(call!.locAdded).toBeUndefined()
    expect(call!.locRemoved).toBeUndefined()
    expect(call!.toolErrors).toBeUndefined()
    expect(call!.interrupted).toBeUndefined()
    expect(call!.userModified).toBeUndefined()
  })

  it('omits fields when the map has no matching tool_use id', () => {
    const map = new Map<string, ToolResultMeta>()
    collectToolResultMeta(toolResultEntry({ toolUseId: 'other', structuredPatch: [{ lines: ['+a'] }] }), map)
    const call = parseApiCall(assistantEntry('m1', ['tu1']), map)
    expect(call!.locAdded).toBeUndefined()
    expect(call!.toolErrors).toBeUndefined()
  })

  it('counts is_error but not a non-error result with stderr', () => {
    // Bash results carry stderr for warnings; only is_error marks a real failure.
    const map = new Map<string, ToolResultMeta>()
    collectToolResultMeta(toolResultEntry({ toolUseId: 'tu1', isError: false }), map)
    const call = parseApiCall(assistantEntry('m1', ['tu1']), map)
    expect(call!.toolErrors).toBeUndefined()
  })
})

// ── gitBranch representation (per-turn dedup) ──────────────────────────

function userText(text: string, branch: string, sessionId = 's1'): JournalEntry {
  return { type: 'user', timestamp: '2026-07-01T10:00:00Z', sessionId, gitBranch: branch, message: { role: 'user', content: text } }
}
function assistant(id: string, branch: string, sessionId = 's1'): JournalEntry {
  return {
    type: 'assistant', timestamp: '2026-07-01T10:00:02Z', sessionId, gitBranch: branch,
    message: { type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', id, content: [], usage: { input_tokens: 5, output_tokens: 5 } },
  }
}

describe('gitBranch capture + dedup', () => {
  it('stores the branch once for a single-branch session', () => {
    const entries = [
      userText('first', 'main'), assistant('m1', 'main'),
      userText('second', 'main'), assistant('m2', 'main'),
    ]
    const turns = groupIntoTurns(entries, new Set())
    expect(turns.map(t => t.gitBranch)).toEqual(['main', 'main'])
    const cached = parsedTurnsToCachedTurns(turns)
    // First turn stores 'main'; second inherits (no stored branch).
    expect(cached[0]!.gitBranch).toBe('main')
    expect(cached[1]!.gitBranch).toBeUndefined()
  })

  it('re-stores the branch at a mid-session switch', () => {
    const entries = [
      userText('a', 'main'), assistant('m1', 'main'),
      userText('b', 'feature/x'), assistant('m2', 'feature/x'),
      userText('c', 'feature/x'), assistant('m3', 'feature/x'),
      userText('d', 'main'), assistant('m4', 'main'),
    ]
    const turns = groupIntoTurns(entries, new Set())
    expect(turns.map(t => t.gitBranch)).toEqual(['main', 'feature/x', 'feature/x', 'main'])
    const cached = parsedTurnsToCachedTurns(turns)
    expect(cached.map(t => t.gitBranch)).toEqual(['main', 'feature/x', undefined, 'main'])
  })
})

// ── per-turn PR references (prRefs) ────────────────────────────────────

function prLink(url: string, sessionId = 's1'): JournalEntry {
  return { type: 'pr-link', timestamp: '2026-07-01T10:00:03Z', sessionId, prUrl: url } as JournalEntry
}

describe('pr-link capture + per-turn prRefs', () => {
  it('attaches a PR referenced during a turn to that turn, and it survives caching', () => {
    const entries = [
      userText('open a PR', 'main'), assistant('m1', 'main'),
      prLink('https://github.com/o/r/pull/1'),
      userText('next task', 'main'), assistant('m2', 'main'),
    ]
    const turns = groupIntoTurns(entries, new Set())
    expect(turns[0]!.prRefs).toEqual(['https://github.com/o/r/pull/1'])
    expect(turns[1]!.prRefs).toBeUndefined()
    const cached = parsedTurnsToCachedTurns(turns)
    // Stored per-turn directly (no change-detection dedup like gitBranch).
    expect(cached[0]!.prRefs).toEqual(['https://github.com/o/r/pull/1'])
    expect(cached[1]!.prRefs).toBeUndefined()
  })

  it('sorts and dedupes multiple refs within one merge-sweep turn', () => {
    const entries = [
      userText('merge sweep', 'main'), assistant('m1', 'main'),
      prLink('https://github.com/o/r/pull/2'),
      prLink('https://github.com/o/r/pull/1'),
      prLink('https://github.com/o/r/pull/2'),
    ]
    const turns = groupIntoTurns(entries, new Set())
    expect(turns[0]!.prRefs).toEqual([
      'https://github.com/o/r/pull/1',
      'https://github.com/o/r/pull/2',
    ])
  })
})

// ── session meta: ai-title last-wins, pr-link accumulation ─────────────

describe('collectSessionMeta', () => {
  it('keeps the LAST ai-title and accumulates unique pr-link URLs', () => {
    const meta = emptySessionMeta()
    collectSessionMeta({ type: 'ai-title', aiTitle: 'first title' } as JournalEntry, meta)
    collectSessionMeta({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/1' } as JournalEntry, meta)
    collectSessionMeta({ type: 'ai-title', aiTitle: 'final title' } as JournalEntry, meta)
    collectSessionMeta({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/1' } as JournalEntry, meta)
    collectSessionMeta({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/2' } as JournalEntry, meta)
    collectSessionMeta({ type: 'user', isSidechain: true } as JournalEntry, meta)

    expect(meta.title).toBe('final title')
    expect(meta.prLinks).toEqual([
      'https://github.com/o/r/pull/1',
      'https://github.com/o/r/pull/2',
    ])
    expect(meta.isSidechain).toBe(true)
  })

  it('leaves fields empty for a session with no meta entries', () => {
    const meta = emptySessionMeta()
    collectSessionMeta({ type: 'user', message: { role: 'user', content: 'hi' } } as JournalEntry, meta)
    expect(meta.title).toBeUndefined()
    expect(meta.prLinks).toEqual([])
    expect(meta.isSidechain).toBe(false)
  })
})
