// Per-element shard streaming: records with huge turn lists must decode one
// turn at a time (the overview-today OOM), never assembled whole.
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { streamShardArrayField } from '../src/shard-stream.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codeburn-shard-walk-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeShard(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe('streamShardArrayField', () => {
  it('yields fields and turns per file in order, dotted keys intact', async () => {
    const path = await writeShard('s.json', JSON.stringify({
      'a.calls.v1.jsonl': {
        fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
        mcpInventory: [],
        turns: [
          { timestamp: 't1', sessionId: 's', userMessage: 'u', calls: [] },
          { timestamp: 't2', sessionId: 's', userMessage: 'u', calls: [{ x: 1 }] },
        ],
      },
      'b.jsonl': { fingerprint: { dev: 5, ino: 6, mtimeMs: 7, sizeBytes: 8 }, mcpInventory: ['m'], turns: [] },
    }))
    const events: string[] = []
    const fields: [string, string][] = []
    const elements: [string, number][] = []
    let endInfo: [string, number, boolean][] = []
    await streamShardArrayField(path, 'turns', {
      onFileStart: key => { events.push(`start:${key}`) },
      onField: (key, field, value) => {
        fields.push([key, field])
        if (field === 'fingerprint') {
          expect(value).toEqual(key === 'b.jsonl'
            ? { dev: 5, ino: 6, mtimeMs: 7, sizeBytes: 8 }
            : { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 })
        }
      },
      onElement: (key, index, value) => {
        elements.push([key, index])
        events.push(`turn:${key}:${index}:${(value as { timestamp: string }).timestamp}`)
      },
      onFileEnd: (key, count, seen) => { endInfo.push([key, count, seen]) },
    })
    expect(events).toEqual([
      'start:a.calls.v1.jsonl',
      'turn:a.calls.v1.jsonl:0:t1',
      'turn:a.calls.v1.jsonl:1:t2',
      'start:b.jsonl',
    ])
    expect(elements).toEqual([['a.calls.v1.jsonl', 0], ['a.calls.v1.jsonl', 1]])
    expect(endInfo).toEqual([['a.calls.v1.jsonl', 2, true], ['b.jsonl', 0, true]])
  })

  it('emits a non-array field value for the consumer to judge', async () => {
    const notArray = await writeShard('n.json', JSON.stringify({ 'f.jsonl': { turns: { oops: 1 }, n: 5 } }))
    const fields: [string, string, unknown][] = []
    const ends: [string, number, boolean][] = []
    await streamShardArrayField(notArray, 'turns', {
      onField: (k, f, v) => { fields.push([k, f, v]) },
      onFileEnd: (k, c, s) => { ends.push([k, c, s]) },
    })
    expect(fields).toEqual([['f.jsonl', 'turns', { oops: 1 }], ['f.jsonl', 'n', 5]])
    expect(ends).toEqual([['f.jsonl', 0, false]])
  })

  it('reports a missing array field', async () => {
    const missing = await writeShard('m.json', JSON.stringify({ 'f.jsonl': { fingerprint: 1 } }))
    const ends: [string, number, boolean][] = []
    await streamShardArrayField(missing, 'turns', { onFileEnd: (k, c, s) => { ends.push([k, c, s]) } })
    expect(ends).toEqual([['f.jsonl', 0, false]])
  })

  it('rejects a duplicated array field instead of concatenating', async () => {
    // Built as raw text: object literals would last-win before the walker
    // ever sees the duplicate. JSON.parse would silently last-win too;
    // concatenating both arrays (or an array plus a later non-array) would
    // serve turns no single value holds.
    const dupArray = await writeShard('d.json', '{"f.jsonl": {"turns": [{"a": 1}], "other": 1, "turns": [{"b": 2}]}}')
    await expect(streamShardArrayField(dupArray, 'turns', {})).rejects.toThrow(/duplicate/)
    const arrayThenScalar = await writeShard('d2.json', '{"f.jsonl": {"turns": [{"a": 1}], "turns": 5}}')
    await expect(streamShardArrayField(arrayThenScalar, 'turns', {})).rejects.toThrow(/duplicate/)
    const scalarThenArray = await writeShard('d3.json', '{"f.jsonl": {"turns": 5, "turns": [{"a": 1}]}}')
    await expect(streamShardArrayField(scalarThenArray, 'turns', {})).rejects.toThrow(/duplicate/)
  })
  it('scopes the walk to a root field with siblings around it', async () => {
    // Codex-results envelope shape: scalar version before, files object,
    // scalar tail after, dotted file keys. Only the files subtree walks.
    const path = await writeShard('env.json', JSON.stringify({
      version: 15,
      files: {
        'a.calls.v1.jsonl': { mtimeMs: 7, calls: [{ timestamp: 't1' }, { timestamp: 't2' }] },
        'b.jsonl': { mtimeMs: 8, calls: [] },
      },
      tail: 'ignored',
    }))
    const fields: [string, string][] = []
    const elements: [string, number][] = []
    const ends: [string, number, boolean][] = []
    await streamShardArrayField(path, 'calls', {
      onField: (k, f) => { fields.push([k, f]) },
      onElement: (k, i) => { elements.push([k, i]) },
      onFileEnd: (k, c, s) => { ends.push([k, c, s]) },
    }, { rootField: 'files' })
    expect(fields).toEqual([['a.calls.v1.jsonl', 'mtimeMs'], ['b.jsonl', 'mtimeMs']])
    expect(elements).toEqual([['a.calls.v1.jsonl', 0], ['a.calls.v1.jsonl', 1]])
    expect(ends).toEqual([['a.calls.v1.jsonl', 2, true], ['b.jsonl', 0, true]])
  })

  it('rejects a scalar file value inside the scoped object', async () => {
    const path = await writeShard('envbad.json', JSON.stringify({ version: 15, files: { 'a.jsonl': 5 } }))
    await expect(streamShardArrayField(path, 'calls', {}, { rootField: 'files' })).rejects.toThrow()
  })
  it('rejects truncated input', async () => {
    const path = await writeShard('t.json', '{"f.jsonl": {"turns": [{')
    await expect(streamShardArrayField(path, 'turns', {})).rejects.toThrow()
  })

  it('rejects a BOM-prefixed shard like JSON.parse does', async () => {
    const path = await writeShard('bom.json', '﻿{"f.jsonl": {"turns": []}}')
    await expect(streamShardArrayField(path, 'turns', {})).rejects.toThrow()
  })
  it('streams thousands of turns without assembling the record', async () => {
    const turns = Array.from({ length: 5000 }, (_, i) => ({ timestamp: `t${i}`, sessionId: 's', userMessage: 'u', calls: [] }))
    const path = await writeShard('big.json', JSON.stringify({ 'big.jsonl': { fingerprint: 1, turns } }))
    let count = 0
    let last = -1
    await streamShardArrayField(path, 'turns', {
      onElement: (_key, index, value) => {
        expect(index).toBe(last + 1)
        last = index
        expect((value as { timestamp: string }).timestamp).toBe(`t${index}`)
        count++
      },
    })
    expect(count).toBe(5000)
  })
})
