import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

let homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const h = homes.pop()
    if (h) await rm(h, { recursive: true, force: true })
  }
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-proxy-cli-'))
  homes.push(home)
  return home
}

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

const configPath = (home: string) => join(home, '.config', 'codeburn', 'config.json')
async function readConfig(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(home), 'utf-8'))
}
async function writeConfig(home: string, obj: unknown): Promise<void> {
  await mkdir(join(home, '.config', 'codeburn'), { recursive: true })
  await writeFile(configPath(home), JSON.stringify(obj), 'utf-8')
}

describe('codeburn proxy-path CLI', () => {
  it('adds, lists, dedupes, and removes a proxy path', async () => {
    const home = await makeHome()

    expect(runCli(['proxy-path', '--list'], home).stdout).toContain('No proxy paths configured')

    const add = runCli(['proxy-path', '/work/copilot-repo'], home)
    expect(add.status).toBe(0)
    expect(add.stdout).toContain('Proxy path saved')
    expect((await readConfig(home)).proxyPaths).toEqual(['/work/copilot-repo'])

    // Trailing-slash variant is the same path -> deduped, not a second entry.
    const dup = runCli(['proxy-path', '/work/copilot-repo/'], home)
    expect(dup.stdout).toContain('already configured')
    expect((await readConfig(home)).proxyPaths).toEqual(['/work/copilot-repo'])

    expect(runCli(['proxy-path', '--list'], home).stdout).toContain('/work/copilot-repo')

    const rm = runCli(['proxy-path', '--remove', '/work/copilot-repo'], home)
    expect(rm.status).toBe(0)
    expect((await readConfig(home)).proxyPaths).toBeUndefined()
  })

  it('rejects a relative path and the filesystem root', async () => {
    const home = await makeHome()
    const rel = runCli(['proxy-path', './rel'], home)
    expect(rel.status).toBe(1)
    expect(rel.stderr).toContain('absolute')

    const root = runCli(['proxy-path', '/'], home)
    expect(root.status).toBe(1)
  })

  it('errors (exit 1) when removing a path that is not configured', async () => {
    const home = await makeHome()
    const res = runCli(['proxy-path', '--remove', '/not/configured'], home)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('No proxy path found')
  })

  it('does not crash on a malformed config (proxyPaths as a non-array)', async () => {
    const home = await makeHome()
    await writeConfig(home, { proxyPaths: 42 })

    const list = runCli(['proxy-path', '--list'], home)
    expect(list.status).toBe(0)
    expect(list.stderr).not.toMatch(/TypeError|is not iterable|is not a function/)
    expect(list.stdout).toContain('No proxy paths configured')

    const add = runCli(['proxy-path', '/work/repo'], home)
    expect(add.status).toBe(0)
    expect(add.stderr).not.toMatch(/TypeError/)
    // The garbage was discarded; only the valid absolute path persists.
    expect((await readConfig(home)).proxyPaths).toEqual(['/work/repo'])
  })

  it('does not crash on a malformed config (proxyPaths array with non-string entries)', async () => {
    const home = await makeHome()
    await writeConfig(home, { proxyPaths: [42, null, '/work/keep'] })
    const add = runCli(['proxy-path', '/work/new'], home)
    expect(add.status).toBe(0)
    expect(add.stderr).not.toMatch(/TypeError|is not a function/)
    expect((await readConfig(home)).proxyPaths).toEqual(['/work/keep', '/work/new'])
  })
})

describe('codeburn report --format json: proxy overview', () => {
  async function writeClaudeSession(home: string, cwd: string): Promise<void> {
    const dir = join(home, '.claude', 'projects', 'proxied')
    await mkdir(dir, { recursive: true })
    const ts = new Date().toISOString()
    const line = JSON.stringify({
      type: 'assistant', sessionId: 's1', timestamp: ts, cwd,
      message: {
        id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 10000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    await writeFile(join(dir, 's1.jsonl'), line + '\n', 'utf-8')
  }

  function overview(home: string): { cost: number; proxiedCost: number; netCost: number } {
    const res = runCli(['report', '--period', 'all', '--format', 'json'], home)
    expect(res.status).toBe(0)
    return JSON.parse(res.stdout).overview
  }

  it('reports proxiedCost == cost and netCost == 0 under a proxy path, and netCost == cost without one', async () => {
    const home = await makeHome()
    const cwd = '/proj/proxiedrepo'
    await writeClaudeSession(home, cwd)

    // Baseline: no proxy config -> nothing attributed, net == cost.
    const base = overview(home)
    expect(base.cost).toBeGreaterThan(0)
    expect(base.proxiedCost).toBe(0)
    expect(base.netCost).toBeCloseTo(base.cost, 10)

    // With the proxy path -> full cost preserved, fully subscription-covered.
    await writeConfig(home, { proxyPaths: [cwd] })
    const proxied = overview(home)
    expect(proxied.cost).toBeCloseTo(base.cost, 10) // cost is never modified
    expect(proxied.proxiedCost).toBeCloseTo(proxied.cost, 10)
    expect(proxied.netCost).toBeCloseTo(0, 10)
    expect(proxied.netCost).toBeCloseTo(proxied.cost - proxied.proxiedCost, 10)
  })
})
