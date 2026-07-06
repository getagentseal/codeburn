import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createZerostackProvider } from '../../src/providers/zerostack.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zerostack-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// Mirrors the real on-disk format: one JSON file per session with cumulative
// token totals (see src/session/mod.rs in zerostack).
function session(opts: {
  id?: string
  model?: string
  provider?: string
  workingDir?: string
  input?: number
  output?: number
  updatedAt?: string
} = {}) {
  return JSON.stringify({
    id: opts.id ?? 'sess-001',
    name: '',
    messages: [
      { role: 'user', content: 'hello, what is this repo about?', estimated_tokens: 7 },
      { role: 'assistant', content: 'It is a minimal coding agent in Rust.', estimated_tokens: 92 },
    ],
    compactions: [],
    created_at: '2026-06-19T11:33:34.022836+00:00',
    updated_at: opts.updatedAt ?? '2026-06-19T11:34:14.140631+00:00',
    total_input_tokens: opts.input ?? 34119,
    total_output_tokens: opts.output ?? 961,
    total_cost: 0.015677835,
    total_estimated_tokens: 446,
    model: opts.model ?? 'deepseek/deepseek-v4-pro',
    provider: opts.provider ?? 'openrouter',
    working_dir: opts.workingDir ?? '/Users/test/myproject',
    permission_allowlist: [],
  })
}

async function write(filename: string, content: string) {
  const path = join(tmpDir, filename)
  await writeFile(path, content)
  return path
}

describe('zerostack provider - discovery', () => {
  it('discovers each session json and derives project from working_dir', async () => {
    await write('sess-001.json', session({ workingDir: '/Users/test/myproject' }))
    const sessions = await createZerostackProvider(tmpDir).discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('zerostack')
    expect(sessions[0]!.project).toBe('myproject')
  })

  it('skips non-json files and unparseable files', async () => {
    await write('notes.txt', 'not a session')
    await write('broken.json', '{ not valid json')
    const sessions = await createZerostackProvider(tmpDir).discoverSessions()
    expect(sessions).toEqual([])
  })

  it('returns empty for a non-existent directory', async () => {
    const sessions = await createZerostackProvider('/nope/does/not/exist').discoverSessions()
    expect(sessions).toEqual([])
  })
})

describe('zerostack provider - parsing', () => {
  async function parse(path: string, seen = new Set<string>()) {
    const provider = createZerostackProvider(tmpDir)
    const source = { path, project: 'myproject', provider: 'zerostack' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
    return calls
  }

  it('emits one cumulative call per session with a resolved cost', async () => {
    const path = await write('sess-abc.json', session({ id: 'sess-abc' }))
    const calls = await parse(path)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('deepseek/deepseek-v4-pro')
    expect(call.inputTokens).toBe(34119)
    expect(call.outputTokens).toBe(961)
    expect(call.sessionId).toBe('sess-abc')
    expect(call.userMessage).toBe('hello, what is this repo about?')
    expect(call.timestamp).toBe('2026-06-19T11:34:14.140631+00:00')
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.deduplicationKey).toContain('zerostack:')
  })

  it('skips sessions with zero tokens', async () => {
    const path = await write('empty.json', session({ input: 0, output: 0 }))
    expect(await parse(path)).toHaveLength(0)
  })

  it('deduplicates across repeated parses', async () => {
    const path = await write('dup.json', session())
    const seen = new Set<string>()
    expect(await parse(path, seen)).toHaveLength(1)
    expect(await parse(path, seen)).toHaveLength(0)
  })

  it('prices unknown local models at zero without throwing', async () => {
    const path = await write('local.json', session({ model: 'my-local-model', provider: 'ollama' }))
    const calls = await parse(path)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(0)
  })
})

describe('zerostack provider - display names', () => {
  const provider = createZerostackProvider('/tmp')

  it('has correct name and displayName', () => {
    expect(provider.name).toBe('zerostack')
    expect(provider.displayName).toBe('Zerostack')
  })

  it('strips the openrouter route prefix from model ids', () => {
    expect(provider.modelDisplayName('deepseek/deepseek-v4-pro')).toBe('DeepSeek v4 Pro')
  })

  it('normalizes tool names', () => {
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})
