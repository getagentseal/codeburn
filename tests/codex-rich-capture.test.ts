import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider, countUnifiedDiffLoc } from '../src/providers/codex.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

// ── unified-diff LOC counting ──────────────────────────────────────────

describe('countUnifiedDiffLoc', () => {
  it('counts +/- content lines and ignores @@ / +++ / --- headers', () => {
    // Shape copied from a real ~/.codex patch_apply_end change (sanitized).
    const diff = '@@ -83,3 +83,3 @@\n \n-SCHEMA_VERSION = 12\n+SCHEMA_VERSION = 13\n # cap\n@@ -107,2 +107,6 @@\n \n+class NewError(AssertionError):\n+    pass\n'
    expect(countUnifiedDiffLoc(diff)).toEqual({ added: 3, removed: 1 })
  })

  it('excludes git-style file headers', () => {
    const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n'
    expect(countUnifiedDiffLoc(diff)).toEqual({ added: 1, removed: 1 })
  })

  it('returns zero for non-string input', () => {
    expect(countUnifiedDiffLoc(undefined)).toEqual({ added: 0, removed: 0 })
    expect(countUnifiedDiffLoc(null)).toEqual({ added: 0, removed: 0 })
  })
})

// ── parser-level: patch_apply_end LOC + failed-edit attribution ─────────

let tmpDir: string
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'codex-rich-')) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

function line(obj: unknown): string { return JSON.stringify(obj) }

async function writeSession(dir: string, date: string, filename: string, lines: string[]): Promise<string> {
  const [year, month, day] = date.split('-')
  const sessionDir = join(dir, 'sessions', year!, month!, day!)
  await mkdir(sessionDir, { recursive: true })
  const filePath = join(sessionDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

async function parseAll(filePath: string): Promise<ParsedProviderCall[]> {
  const provider = createCodexProvider(tmpDir)
  const source = { path: filePath, project: 'test', provider: 'codex' }
  const parser = provider.createSessionParser(source, new Set())
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

const patchApplyEnd = (opts: { changes: Record<string, string>; success?: boolean }) => line({
  type: 'event_msg',
  timestamp: '2026-04-14T10:00:30Z',
  payload: {
    type: 'patch_apply_end',
    success: opts.success ?? true,
    changes: Object.fromEntries(Object.entries(opts.changes).map(([f, d]) => [f, { type: 'update', unified_diff: d, move_path: null }])),
  },
})

const tokenCount = () => line({
  type: 'event_msg',
  timestamp: '2026-04-14T10:01:00Z',
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }, total_token_usage: { total_tokens: 150 } } },
})

describe('codex parser - patch_apply_end capture', () => {
  it('attaches locAdded/locRemoved summed across changed files', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-loc.jsonl', [
      line({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { cwd: '/Users/t/p', originator: 'codex-cli', session_id: 'sx', model: 'gpt-5.3-codex' } }),
      line({ type: 'response_item', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'edit files' }] } }),
      patchApplyEnd({ changes: {
        '/Users/t/p/a.ts': '@@ -1 +1,2 @@\n-old\n+new\n+extra\n',
        '/Users/t/p/b.ts': '@@ -1,2 +1 @@\n-x\n-y\n+z\n',
      } }),
      tokenCount(),
    ])
    const calls = await parseAll(filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.locAdded).toBe(3)
    expect(calls[0]!.locRemoved).toBe(3)
    expect(calls[0]!.editFailed).toBeUndefined()
  })

  it('counts a failed patch application', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-fail.jsonl', [
      line({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { cwd: '/Users/t/p', originator: 'codex-cli', session_id: 'sy', model: 'gpt-5.3-codex' } }),
      line({ type: 'response_item', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'edit' }] } }),
      patchApplyEnd({ success: false, changes: { '/Users/t/p/a.ts': '@@ -1 +1 @@\n-old\n+new\n' } }),
      tokenCount(),
    ])
    const calls = await parseAll(filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.editFailed).toBe(1)
    expect(calls[0]!.locAdded).toBe(1)
    expect(calls[0]!.locRemoved).toBe(1)
  })

  it('omits LOC fields for a turn with no patch', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-nopatch.jsonl', [
      line({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { cwd: '/Users/t/p', originator: 'codex-cli', session_id: 'sz', model: 'gpt-5.3-codex' } }),
      line({ type: 'response_item', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
      tokenCount(),
    ])
    const calls = await parseAll(filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.locAdded).toBeUndefined()
    expect(calls[0]!.locRemoved).toBeUndefined()
    expect(calls[0]!.editFailed).toBeUndefined()
  })
})
