import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import * as fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readCodexSessionNames } from '../src/codex-session-index.js'

vi.mock('fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'codex-names-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

describe('optional Codex session index', () => {
  it('uses the newest valid name, with append order breaking ties and supporting old records', async () => {
    await writeFile(join(home, 'session_index.jsonl'), [
      { id: 'renamed', thread_name: 'Original', updated_at: '2026-10-01T10:00:00Z' },
      { id: 'renamed', thread_name: 'Renamed', updated_at: '2026-10-02T10:00:00Z' },
      { id: 'renamed', thread_name: 'Stale snapshot', updated_at: '2026-10-01T12:00:00Z' },
      { id: 'legacy', thread_name: 'First' },
      { id: 'legacy', thread_name: 'Last' },
      { id: 'tie', thread_name: 'First', updated_at: '2026-10-02T10:00:00Z' },
      { id: 'tie', thread_name: 'Last', updated_at: '2026-10-02T10:00:00Z' },
    ].map(JSON.stringify).join('\n'))
    expect(await readCodexSessionNames([home, home])).toEqual(new Map([
      ['renamed', 'Renamed'], ['legacy', 'Last'], ['tie', 'Last'],
    ]))
  })

  it('ignores malformed and blank entries and bounds/sanitizes displayed text', async () => {
    await writeFile(join(home, 'session_index.jsonl'), [
      JSON.stringify({ id: 'safe', thread_name: 'Keep' }),
      'broken JSON', 'null', '[]', '{}', '',
      JSON.stringify({ id: 'safe', thread_name: ' \n\t ' }),
      JSON.stringify({ id: '', thread_name: 'No id' }),
      JSON.stringify({ id: 1, thread_name: 'Invalid id' }),
      JSON.stringify({ id: 'bad', thread_name: {} }),
      JSON.stringify({ id: 'long', thread_name: '  hello\n\x1b[31m' + 'x'.repeat(300) }),
    ].join('\n'))
    const names = await readCodexSessionNames([home])
    expect(names.get('safe')).toBe('Keep')
    expect(names.size).toBe(2)
    expect(names.get('long')).toHaveLength(200)
    expect(names.get('long')).toMatch(/^hello\?\?\[31m/)
    expect(names.get('long')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  })

  it('tolerates absent, unreadable and non-file indexes', async () => {
    expect(await readCodexSessionNames([home])).toEqual(new Map())
    await mkdir(join(home, 'session_index.jsonl'))
    expect(await readCodexSessionNames([home])).toEqual(new Map())
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await readCodexSessionNames([home])).toEqual(new Map())
  })

  it('reads all supplied homes and keeps the newest name for shared IDs', async () => {
    const other = join(home, 'other')
    await mkdir(other)
    await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: 'same', thread_name: 'New', updated_at: '2026-10-02' }))
    await writeFile(join(other, 'session_index.jsonl'), JSON.stringify({ id: 'same', thread_name: 'Old', updated_at: '2026-10-01' }))
    expect((await readCodexSessionNames([home, other])).get('same')).toBe('New')
  })
})
