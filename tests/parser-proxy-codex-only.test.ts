import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, it } from 'vitest'

// A non-Claude provider records its project path with the leading slash stripped
// ("Users/test/x"), while a configured proxy path keeps it ("/Users/test/x").
// Matching must be leading-slash agnostic, or a Codex-ONLY project under a proxy
// path is silently reported as out-of-pocket even though the SAME path is flagged
// when a Claude session happens to co-exist there (covered by the merge test) —
// i.e. attribution would depend on incidental provider co-location.
//
// This lives in its own file because the codex provider captures CODEX_HOME when
// its module is first evaluated; isolating it gives a fresh module graph that
// reads the env set below before the dynamic import.

const CWD = '/Users/test/codexonlyproxied'
let tmpDirs: string[] = []

afterEach(async () => {
  delete process.env['CODEX_HOME']
  delete process.env['CLAUDE_CONFIG_DIR']
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

it('flags a Codex-only project under a proxy path (leading-slash agnostic match)', async () => {
  // Codex fixture (the only sessions present).
  const home = await mkdtemp(join(tmpdir(), 'codeburn-codexonly-'))
  tmpDirs.push(home)
  const dir = join(home, 'sessions', '2026', '04', '16')
  await mkdir(dir, { recursive: true })
  const meta = JSON.stringify({
    type: 'session_meta', timestamp: '2026-04-16T10:00:00Z',
    payload: { cwd: CWD, originator: 'codex-cli', session_id: 'codex-1', model: 'gpt-5.3-codex' },
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

  // Empty Claude dir so the only project is the Codex one.
  const claudeEmpty = await mkdtemp(join(tmpdir(), 'codeburn-codexonly-claude-'))
  tmpDirs.push(claudeEmpty)
  await mkdir(join(claudeEmpty, 'projects'), { recursive: true })
  process.env['CLAUDE_CONFIG_DIR'] = claudeEmpty

  // Import AFTER env is set so the codex provider reads CODEX_HOME.
  const { parseAllSessions, clearSessionCache } = await import('../src/parser.js')
  const { setProxyPaths, loadPricing } = await import('../src/models.js')
  await loadPricing()
  setProxyPaths([CWD])
  clearSessionCache()

  const range = { start: new Date(Date.UTC(2026, 3, 15)), end: new Date(Date.UTC(2026, 3, 17)) }
  const projects = await parseAllSessions(range, 'all')

  const codex = projects.find(p => p.sessions.some(s => s.turns.some(t => t.assistantCalls.some(c => c.provider === 'codex'))))
  expect(codex).toBeDefined()
  expect(codex!.totalCostUSD).toBeGreaterThan(0)
  // The fix: leading-slash agnostic matching flags the Codex-only project.
  expect(codex!.totalProxiedCostUSD).toBeCloseTo(codex!.totalCostUSD, 10)

  setProxyPaths([])
  clearSessionCache()
})
