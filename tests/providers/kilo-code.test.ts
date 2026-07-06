import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { kiloCode, createKiloCodeProvider } from '../../src/providers/kilo-code.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

describe('kilo-code provider - discovery path differentiation', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kilo-code-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers tasks using kilo-code extension path', async () => {
    const task = join(tmpDir, 'tasks', 'task-kilo-1')
    await mkdir(task, { recursive: true })
    await writeFile(join(task, 'ui_messages.json'), JSON.stringify([
      { type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 100, tokensOut: 50 }), ts: 1700000000000 },
    ]))

    const provider = createKiloCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    const fromOverride = sessions.filter(s => s.path.startsWith(tmpDir))

    expect(fromOverride).toHaveLength(1)
    expect(fromOverride[0]!.provider).toBe('kilo-code')
  })

  it('parses with kilo-code provider name in dedup key', async () => {
    const task = join(tmpDir, 'tasks', 'task-kilo-2')
    await mkdir(task, { recursive: true })
    await writeFile(join(task, 'ui_messages.json'), JSON.stringify([
      { type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 200, tokensOut: 100 }), ts: 1700000000000 },
    ]))

    const source = { path: task, project: 'task-kilo-2', provider: 'kilo-code' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiloCode.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('kilo-code')
    expect(calls[0]!.deduplicationKey).toMatch(/^kilo-code:/)
  })
})

describe('kilo-code provider - metadata', () => {
  it('has correct name and displayName', () => {
    expect(kiloCode.name).toBe('kilo-code')
    expect(kiloCode.displayName).toBe('KiloCode')
  })

  it('uses different extension ID than roo-code', () => {
    expect(kiloCode.name).toBe('kilo-code')
    expect(kiloCode.name).not.toBe('roo-code')
  })
})
