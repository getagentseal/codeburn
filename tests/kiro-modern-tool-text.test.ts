/**
 * Kiro IDE modern-execution files must take tool names only from structured
 * fields, never from message text.
 *
 * The modern parser used to run the `<tool_use><name>X</name>` markup scan
 * over the text of every message, including `tool` messages, which carry tool
 * OUTPUT (file contents, command output). Any content containing that markup
 * became a tool call, and `codeburn sync` sent the name upstream - private
 * text leaking out as fake tool data. Real execution files record tool calls
 * as structured entries and `usageSummary[].usedTools`; none carry the markup.
 *
 * The legacy `.chat` format has no structured tool record, so its bot-message
 * markup scan is kept and pinned here as unchanged.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'

// The kiro provider captures homedir() at import, so HOME must point at the
// test root before ../src/parser.js is evaluated (see kiro-cache-invalidation).
const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/kiro-tool-text-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  return root
})

const HOME = join(testRoot, 'home')
const CACHE_DIR = join(testRoot, 'cache')
const LEAK = '<tool_use><name>orion_merger_initech</name></tool_use>'

function kiroAgentDir(): string {
  if (process.platform === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  if (process.platform === 'win32') {
    return join(HOME, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  return join(HOME, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
}

// Execution files sit one level below the workspace dir; legacy `.chat` files
// are discovered only directly inside it.
async function writeAgentFile(name: string, body: unknown): Promise<void> {
  const workspace = join(kiroAgentDir(), 'a'.repeat(32))
  const dir = name.endsWith('.chat') ? workspace : join(workspace, 'b'.repeat(32))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), JSON.stringify(body))
}

function execution(id: string, messages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    executionId: id,
    workflowType: 'chat-agent',
    status: 'succeed',
    startTime: 1780000000000,
    chatSessionId: `session-${id}`,
    context: { messages },
    ...extra,
  }
}

async function kiroTools(): Promise<string[]> {
  const projects = await parseAllSessions(undefined, 'kiro')
  return projects
    .flatMap(p => p.sessions)
    .flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls)
    .flatMap(c => c.tools)
}

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

afterAll(async () => {
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

describe('Kiro modern execution tool names', () => {
  it('ignores tool markup inside tool output', async () => {
    await writeAgentFile('exec-tool-output', execution('exec-tool-output', [
      { role: 'human', entries: [{ type: 'text', text: 'read the notes file' }] },
      { role: 'bot', entries: [{ type: 'text', text: 'Reading it now.' }] },
      { role: 'tool', entries: [{ type: 'toolUseResponse', message: `notes: ${LEAK}`, success: true }] },
    ]))

    const tools = await kiroTools()
    expect(tools).not.toContain('orion_merger_initech')
  })

  it('ignores tool markup inside assistant text', async () => {
    await writeAgentFile('exec-bot-text', execution('exec-bot-text', [
      { role: 'human', entries: [{ type: 'text', text: 'show the format' }] },
      { role: 'bot', entries: [{ type: 'text', text: `It looks like ${LEAK}` }] },
    ]))

    const tools = await kiroTools()
    expect(tools).not.toContain('orion_merger_initech')
  })

  it('ignores tool markup in a top-level response field', async () => {
    await writeAgentFile('exec-direct', {
      executionId: 'exec-direct',
      chatSessionId: 'session-exec-direct',
      startTime: 1780000000000,
      prompt: 'show the format',
      response: `It looks like ${LEAK}`,
    })

    const tools = await kiroTools()
    expect(tools).not.toContain('orion_merger_initech')
  })

  it('still counts structured usedTools', async () => {
    await writeAgentFile('exec-used', execution('exec-used', [
      { role: 'human', entries: [{ type: 'text', text: 'search github' }] },
      { role: 'bot', entries: [{ type: 'text', text: 'Searching.' }] },
    ], { usageSummary: [{ usage: 1, usedTools: ['mcp_github_search'] }] }))

    const tools = await kiroTools()
    expect(tools).toContain('github_search')
  })
})

describe('Kiro legacy .chat tool names', () => {
  it('still reads tool markup from bot messages', async () => {
    await writeAgentFile('legacy.chat', {
      executionId: 'exec-legacy',
      actionId: 'act-legacy',
      chat: [
        { role: 'human', content: 'read the file' },
        { role: 'bot', content: '<tool_use><name>readFile</name></tool_use>' },
      ],
      metadata: {
        modelId: 'claude-sonnet-4.5',
        modelProvider: 'anthropic',
        workflow: 'chat',
        workflowId: 'wf-legacy',
        startTime: 1780000000000,
        endTime: 1780000005000,
      },
    })

    const tools = await kiroTools()
    expect(tools.length).toBeGreaterThan(0)
  })
})
