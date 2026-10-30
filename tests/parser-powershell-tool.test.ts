import { describe, expect, it } from 'vitest'

import { classifyTurn } from '../src/classifier.js'
import { compactEntry, parseApiCall } from '../src/parser.js'
import type { ContentBlock, JournalEntry, ParsedTurn } from '../src/types.js'

// Claude Code on Windows runs shell commands through a tool named PowerShell,
// with the same { command } input as Bash. It must count as a shell tool: its
// command survives compaction, feeds the shell breakdown, and lets a turn that
// only ran commands be classified by what the user asked for.

const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 }

function line(content: ContentBlock[]): JournalEntry {
  return {
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-10-27T10:00:00.000Z',
    message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content, usage },
  }
}

const powershell = (command: string): ContentBlock => ({ type: 'tool_use', id: 't1', name: 'PowerShell', input: { command, description: 'Run it' } })

function turnOf(entry: JournalEntry, userMessage: string): ParsedTurn {
  return { userMessage, assistantCalls: [parseApiCall(entry)!], timestamp: entry.timestamp!, sessionId: 's1' }
}

describe('Claude Code PowerShell tool', () => {
  it('keeps the command through compaction', () => {
    const compacted = compactEntry(line([powershell('npm test')]))
    const block = (compacted.message!.content as ContentBlock[])[0] as { input: Record<string, unknown> }
    expect(block.input).toEqual({ command: 'npm test' })
  })

  it('extracts its commands into the shell breakdown', () => {
    const call = parseApiCall(line([powershell('cd C:\\work\\app; git status; npm test')]))
    expect(call?.tools).toEqual(['PowerShell'])
    expect(call?.bashCommands).toEqual(['git', 'npm'])
  })

  it('classifies a command-only turn by the request, as it does for Bash', () => {
    const cases: Array<[string, string, string]> = [
      ['npx vitest run', 'run the test suite', 'testing'],
      ['git commit -m "fix"', 'git commit this', 'git'],
      ['npm run build', 'npm run build and report errors', 'build/deploy'],
    ]
    for (const [command, request, category] of cases) {
      const bash: ContentBlock = { type: 'tool_use', id: 't1', name: 'Bash', input: { command } }
      expect(classifyTurn(turnOf(line([powershell(command)]), request)).category).toBe(category)
      expect(classifyTurn(turnOf(line([bash]), request)).category).toBe(category)
    }
  })
})
