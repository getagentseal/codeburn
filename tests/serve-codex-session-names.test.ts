import { expect, it } from 'vitest'
import { spawn } from 'child_process'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'fs/promises'
import { createInterface } from 'readline'
import { join } from 'path'
import { tmpdir } from 'os'

it('refreshes names after index creation, replacement and removal despite a resident output memo', async () => {
  const home = await mkdtemp(join(tmpdir(), 'serve-codex-names-'))
  const codex = join(home, '.codex')
  const dir = join(codex, 'sessions', '2026', '10', '01')
  const id = '019a0000-1111-7000-8000-000000000001'
  const index = join(codex, 'session_index.jsonl')
  await mkdir(dir, { recursive: true })
  const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
  await writeFile(join(dir, `rollout-2026-10-01T10-00-00-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd: '/test', model: 'gpt-5.5' } },
    { type: 'event_msg', timestamp: '2026-10-01T10:01:00Z', payload: { type: 'token_count', info: { model: 'gpt-5.5', last_token_usage: usage, total_token_usage: usage } } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--stdio'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex, CODEBURN_CACHE_DIR: join(home, 'cache') },
  })
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()))
  const lines = createInterface({ input: child.stdout })
  const waiters = new Map<number, (value: { output: string; generation: { n: number } }) => void>()
  let requestId = 0
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.ok !== undefined) { waiters.get(message.id)?.(message); waiters.delete(message.id) }
  })
  const request = () => new Promise<{ output: string; generation: { n: number } }>(resolve => {
    const id = ++requestId
    waiters.set(id, resolve)
    child.stdin.write(JSON.stringify({ id, args: ['sessions', '--provider', 'codex', '--from', '2026-10-01', '--to', '2026-10-01', '--format', 'json'] }) + '\n')
  })
  try {
    let last = await request()
    let memoized = false
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const next = await request()
      if (next.generation.n === last.generation.n) { memoized = true; break }
      last = next
    }
    expect(memoized).toBe(true)
    const original = JSON.parse(last.output)
    expect(original).toHaveLength(1)
    expect(original[0].title).toBe('')
    await writeFile(index, JSON.stringify({ id, thread_name: 'First name' }) + '\n')
    expect(JSON.parse((await request()).output)[0].title).toBe('First name')
    await writeFile(index + '.tmp', JSON.stringify({ id, thread_name: 'Renamed task' }) + '\n')
    await rename(index + '.tmp', index)
    const renamed = JSON.parse((await request()).output)
    expect(renamed[0].title).toBe('Renamed task')
    expect({ ...renamed[0], title: '' }).toEqual(original[0])
    await rm(index)
    expect(JSON.parse((await request()).output)).toEqual(original)
  } finally {
    lines.close()
    child.kill()
    await exited
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
