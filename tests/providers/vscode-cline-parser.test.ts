import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, posix, win32 } from 'path'
import { tmpdir } from 'os'

import { discoverClineTasks, getVSCodeGlobalStoragePaths } from '../../src/providers/vscode-cline-parser.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'vscode-cline-parser-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeTask(baseDir: string, taskId: string): Promise<void> {
  const taskDir = join(baseDir, 'tasks', taskId)
  await mkdir(taskDir, { recursive: true })
  await writeFile(join(taskDir, 'ui_messages.json'), '[]')
}

describe('VS Code Cline-family storage discovery', () => {
  it('includes VSCodium globalStorage paths on all supported platforms', () => {
    const extensionId = 'example.extension'

    expect(getVSCodeGlobalStoragePaths(extensionId, '/Users/test', 'darwin')).toContain(
      posix.join('/Users/test', 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', extensionId),
    )
    expect(getVSCodeGlobalStoragePaths(extensionId, 'C:\\Users\\test', 'win32')).toContain(
      win32.join('C:\\Users\\test', 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage', extensionId),
    )
    expect(getVSCodeGlobalStoragePaths(extensionId, '/home/test', 'linux')).toContain(
      posix.join('/home/test', '.config', 'VSCodium', 'User', 'globalStorage', extensionId),
    )
  })

  it('discovers tasks across multiple VS Code-compatible storage roots', async () => {
    const codeRoot = join(tmpDir, 'Code', 'User', 'globalStorage', 'example.extension')
    const codiumRoot = join(tmpDir, 'VSCodium', 'User', 'globalStorage', 'example.extension')
    await writeTask(codeRoot, 'task-code')
    await writeTask(codiumRoot, 'task-codium')

    const sessions = await discoverClineTasks(
      'example.extension',
      'example-provider',
      'Example Provider',
      [codeRoot, codiumRoot],
    )

    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.path).sort()).toEqual([
      join(codeRoot, 'tasks', 'task-code'),
      join(codiumRoot, 'tasks', 'task-codium'),
    ].sort())
  })
})

import { createClineParser } from '../../src/providers/vscode-cline-parser.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

describe('VS Code Cline-family parse hardening', () => {
  it('yields with an empty timestamp instead of throwing on a malformed ts', async () => {
    // entry.ts is only truthy-checked; a garbage value made new Date(ts)
    // .toISOString() throw RangeError and abort the whole session parse.
    const taskDir = join(tmpDir, 'tasks', 'bad-ts')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'ui_messages.json'), JSON.stringify([
      { type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 100, tokensOut: 50 }), ts: 'not-a-real-timestamp' },
    ]))
    await writeFile(join(taskDir, 'api_conversation_history.json'), JSON.stringify([
      { role: 'user', content: [{ type: 'text', text: 'hi\n<environment_details>\n</environment_details>' }] },
    ]))

    const source = { path: taskDir, project: 'p', provider: 'cline' }
    const calls: ParsedProviderCall[] = []
    for await (const call of createClineParser(source, new Set(), 'cline').parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe('')
    expect(calls[0]!.inputTokens).toBe(100)
  })
})
