import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, basename } from 'path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { collectJsonlFiles } from '../src/parser.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codeburn-collect-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('collectJsonlFiles', () => {
  // Regression for #470: workflow/ultracode subagent transcripts live nested at
  // `<session>/subagents/workflows/<wf>/agent-*.jsonl`. A flat scan dropped them,
  // so usage went uncounted whenever the workflow feature was on.
  it('collects nested workflow subagent transcripts, not just top-level subagent files', async () => {
    const sessionDir = join(root, 'session-1')
    const wfDir = join(sessionDir, 'subagents', 'workflows', 'wf_abc')
    await mkdir(wfDir, { recursive: true })

    await writeFile(join(root, 'session-1.jsonl'), '{}\n')
    await writeFile(join(sessionDir, 'subagents', 'agent-direct.jsonl'), '{}\n')
    await writeFile(join(wfDir, 'agent-nested.jsonl'), '{}\n')
    // Sidecar metadata must never be picked up as a transcript.
    await writeFile(join(wfDir, 'agent-nested.meta.json'), '{}\n')

    const found = (await collectJsonlFiles(root)).map(f => basename(f)).sort()

    expect(found).toContain('session-1.jsonl')
    expect(found).toContain('agent-direct.jsonl')
    expect(found).toContain('agent-nested.jsonl')
    expect(found).not.toContain('agent-nested.meta.json')
  })

  it('returns an empty list for a missing directory without throwing', async () => {
    await expect(collectJsonlFiles(join(root, 'does-not-exist'))).resolves.toEqual([])
  })
})
