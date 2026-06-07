import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

// Regression guard for the cross-provider merge in parseAllSessions: when the
// same repo is used with Claude Code AND another tool (Codex), the two
// ProjectSummaries merge by canonical path and totalCostUSD is summed. The
// merge must RE-DERIVE totalProxiedCostUSD from the final path+cost, or only
// the first-seen provider's proxied amount survives and net out-of-pocket is
// overstated — silently reintroducing the exact bug issue #417 fixes.
//
// The codex provider captures its sessions dir (CODEX_HOME) when its module is
// first evaluated, so this file sets the env and creates fixtures BEFORE a
// dynamic import of the parser. A hyphen-free cwd is used so codex's
// sanitize/unsanitize path round-trips to the same merge key as Claude.

const MERGE_CWD = '/Users/test/proxiedmerge'
let tmpDirs: string[] = []

afterEach(async () => {
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEX_HOME']
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

async function writeClaudeFixture(cwd: string): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'codeburn-merge-claude-'))
  tmpDirs.push(base)
  const dir = join(base, 'projects', 'p')
  await mkdir(dir, { recursive: true })
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-04-16T10:00:00.000Z',
    sessionId: 's1',
    cwd,
    message: {
      type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', id: 'm1', content: [],
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
  await writeFile(join(dir, 's1.jsonl'), line + '\n', 'utf-8')
  process.env['CLAUDE_CONFIG_DIR'] = base
}

async function writeCodexFixture(cwd: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-merge-codex-'))
  tmpDirs.push(home)
  const dir = join(home, 'sessions', '2026', '04', '16')
  await mkdir(dir, { recursive: true })
  const meta = JSON.stringify({
    type: 'session_meta', timestamp: '2026-04-16T10:00:00Z',
    payload: { cwd, originator: 'codex-cli', session_id: 'codex-1', model: 'gpt-5.3-codex' },
  })
  const tokens = JSON.stringify({
    type: 'event_msg', timestamp: '2026-04-16T10:01:00Z',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5.3-codex',
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 1200 },
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 1200 },
      },
    },
  })
  await writeFile(join(dir, 'rollout-codex-1.jsonl'), meta + '\n' + tokens + '\n', 'utf-8')
  process.env['CODEX_HOME'] = home
}

describe('proxy pricing: cross-provider merge', () => {
  it('re-derives proxied == total when Claude and Codex sessions merge under a proxy path', async () => {
    await writeClaudeFixture(MERGE_CWD)
    await writeCodexFixture(MERGE_CWD)

    // Import AFTER env is set so the codex provider reads CODEX_HOME.
    const { parseAllSessions, clearSessionCache } = await import('../src/parser.js')
    const { setProxyPaths, loadPricing } = await import('../src/models.js')
    await loadPricing()
    setProxyPaths([MERGE_CWD])
    clearSessionCache()

    const range = { start: new Date(Date.UTC(2026, 3, 15)), end: new Date(Date.UTC(2026, 3, 17)) }
    const projects = await parseAllSessions(range, 'all')

    // Sanity: both providers landed in a single merged project (proves the
    // cross-provider merge path actually ran, not just a lone Claude project).
    expect(projects).toHaveLength(1)
    const merged = projects[0]!
    const providers = new Set(
      merged.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls.map(c => c.provider))),
    )
    expect(providers.has('claude')).toBe(true)
    expect(providers.has('codex')).toBe(true)

    // The fix: the whole merged total is subscription-covered, not just the
    // first provider's slice. Without the merge re-derivation this is < total.
    expect(merged.totalProxiedCostUSD).toBeCloseTo(merged.totalCostUSD, 10)
    expect(merged.totalCostUSD - merged.totalProxiedCostUSD).toBeCloseTo(0, 10)

    setProxyPaths([])
    clearSessionCache()
  })
})
