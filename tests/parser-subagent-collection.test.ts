import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, basename } from 'path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { collectJsonlFiles, readAgentType } from '../src/parser.js'

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

describe('readAgentType (Claude-scoped agent-type detection)', () => {
  it('reads agentType from a subagent transcript’s sibling .meta.json', async () => {
    const dir = join(root, 'session', 'subagents')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent-x.jsonl'), '{}\n')
    await writeFile(join(dir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore' }))
    expect(await readAgentType(join(dir, 'agent-x.jsonl'))).toBe('Explore')
  })

  it('falls back to workflow-subagent for nested workflow agents without a meta', async () => {
    const dir = join(root, 'session', 'subagents', 'workflows', 'wf_1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent-y.jsonl'), '{}\n')
    expect(await readAgentType(join(dir, 'agent-y.jsonl'))).toBe('workflow-subagent')
  })

  it('returns undefined for an ordinary (non-subagent) session file', async () => {
    await writeFile(join(root, 'session.jsonl'), '{}\n')
    expect(await readAgentType(join(root, 'session.jsonl'))).toBeUndefined()
  })
})
