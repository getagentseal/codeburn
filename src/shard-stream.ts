// Bounded-memory JSON object decoding for multi-hundred-MB cache shards.
import type { FileHandle } from 'node:fs/promises'

/// Write a whole text chunk: FileHandle.write may write partially
/// (bytesWritten), especially for large serialized entries, and a short write
/// without a loop produces a corrupt shard. Loop until fully flushed.
export async function writeChunk(handle: FileHandle, text: string): Promise<void> {
  const buffer = Buffer.from(text, 'utf-8')
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null)
    offset += bytesWritten
  }
}

//
// A shard payload is one top-level JSON object mapping paths to records.
// `JSON.parse` retains the whole text plus the whole object graph at once
// (~3x file bytes of live heap); on the 498MB OMP month shard that alone
// OOMs a default-heap run. These helpers stream-decode instead, emitting one
// top-level entry at a time so callers retain only what the query needs.
//
// Error semantics mirror whole-file parsing exactly: ANY decode failure
// (truncated file, invalid token, read error, non-object root) throws, and
// callers must discard the entries decoded so far — a torn shard is dropped
// whole, never partially committed. Chunk-boundary correctness (UTF-8 splits,
// `\uXXXX` escapes spanning reads) comes from the stream-json tokenizer, not
// hand-rolled state; do not reimplement it here.
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { parser } from 'stream-json'
import { Assembler } from 'stream-json/assembler.js'
import { streamObject, type StreamObjectItem } from 'stream-json/streamers/stream-object.js'

import { flatString } from './content-utils.js'

// Test barrier (see the load-spanning-flush test): invoked once the entries
// stream opens its file descriptor, so tests can stage a concurrent publish
// deterministically. Never set outside tests.
let afterStreamOpenForTests: (() => void) | null = null
export function __setAfterStreamOpenForTests(hook: (() => void) | null): void {
  afterStreamOpenForTests = hook
}

export type ShardEntry = { key: string; value: unknown }

/** First non-whitespace byte of a file, or null if empty. A BOM is not
* skipped: `JSON.parse` rejects it, so a BOM-prefixed shard is dropped just
* like the whole-file decoder dropped it (the tokenizer would agree). */
async function peekFirstByte(path: string): Promise<number | null> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(64)
    const { bytesRead } = await handle.read(buf, 0, 64, 0)
    for (let i = 0; i < bytesRead; i++) {
      const byte = buf[i]!
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
      return byte
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
* Stream the top-level entries of the JSON object at `path`, invoking
* `onEntry` once per entry in document order (awaited, so writers keep
* backpressure instead of buffering the shard). Resolves only after a clean
* end-of-stream; anything else (truncated/corrupt/unreadable input, a
* non-object root) rejects, and the caller must discard entries seen so far.
*/
export async function streamShardEntries(
  path: string,
  onEntry: (entry: ShardEntry) => void | Promise<void>,
): Promise<void> {
  let first: number | null
  try {
    first = await peekFirstByte(path)
  } catch {
    throw new Error(`shard unreadable: ${path}`)
  }
  if (first === null) throw new Error(`shard unreadable: ${path}`)
  if (first !== 0x7b) throw new Error(`shard root is not an object: ${path}`)
  await pipeline(
    createReadStream(path),
    parser.asStream(),
    streamObject.asStream(),
    async function* (entries: AsyncIterable<StreamObjectItem>) {
      for await (const entry of entries) {
        if (typeof entry?.key !== 'string') throw new Error(`shard entry without key: ${path}`)
        await onEntry({ key: flatString(entry.key), value: entry.value })
      }
    },
  )
}

//
// Per-element streaming inside one named array field of every top-level
// entry. `streamShardEntries` above assembles each whole record before the
// caller sees it; when the record is a cached session file with tens of
// thousands of turns, that one assembly is the OOM (a single month shard can
// hold a record whose turns expand past 512MB). This walker assembles at most
// ONE array element (plus one metadata field) at a time: element callbacks
// decide keep/drop per element while dropped elements are still hot, so peak
// Mechanics: a hand-rolled token walk over the packing parser's output (keys
// as `keyValue`, strings/numbers whole — the parser defaults, which the
// Assembler also requires). Genuinely unexpected shapes (chunked strings,
// separate key tokens, deeper nesting) throw fail-closed: the caller discards
// the shard exactly as for a torn file. A non-array value under the array
// field name is NOT one of those: it is emitted as a plain field so the
// consumer decides (session shards reject it at validation; the codex
// retained-key scan keeps the entry). Capture boundaries are exact stack
// paths (`[entryKey, arrayField, index]` for elements, `[entryKey, field]`
// for metadata), so dotted entry keys can never misfire them.
export type ShardArrayFieldCallbacks = {
  onFileStart?: (key: string) => void | Promise<void>
  /** Every non-array top-level field of the entry, in document order. */
  onField?: (key: string, field: string, value: unknown) => void | Promise<void>
  /** One array element, in document order with its index. */
  onElement?: (key: string, index: number, value: unknown) => void | Promise<void>
  /** arraySeen is false when the entry has no arrayField at all. */
  onFileEnd?: (key: string, elementCount: number, arraySeen: boolean) => void | Promise<void>
}

type ParserToken = Parameters<Assembler['consume']>[0]

const SCALAR_TOKENS = new Set(['stringValue', 'numberValue', 'nullValue', 'trueValue', 'falseValue'])
const START_TOKENS = new Set(['startObject', 'startArray'])

function assembleTokens(tokens: ParserToken[]): unknown {
  // Detach strings from the tokenizer's buffers: every retained stringValue
  // or key would otherwise pin its whole input chunk for the life of the
  // cache (V8 SlicedString), ballooning streaming decode past whole-file
  // JSON.parse. Buffer round-trip forces fresh flat strings (see flatString).
  const asm = new Assembler()
  for (const token of tokens) {
    if ((token.name === 'stringValue' || token.name === 'keyValue') && 'value' in token && typeof token.value === 'string') {
      asm.consume({ ...token, value: flatString(token.value) })
    } else {
      asm.consume(token)
    }
  }
  return asm.current
}

export async function streamShardArrayField(
  path: string,
  arrayField: string,
  cb: ShardArrayFieldCallbacks,
  opts?: { rootField?: string },
): Promise<void> {
  let first: number | null
  try {
    first = await peekFirstByte(path)
  } catch {
    throw new Error(`shard unreadable: ${path}`)
  }
  if (first === null) throw new Error(`shard unreadable: ${path}`)
  if (first !== 0x7b) throw new Error(`shard root is not an object: ${path}`)
  const source = createReadStream(path)
  const openHook = afterStreamOpenForTests
  if (openHook) source.once('open', openHook)
  await pipeline(
    source,
    // Packed tokens only (keys as `keyValue`, whole strings/numbers): the
    // defaults also emit streamed duplicates (startKey/stringChunk/...) that
    // this walk does not track.
    parser.asStream({ streamValues: false }),
    async function* (tokens: AsyncIterable<ParserToken>) {
      // Container frames; the root object itself is never pushed, so a file
      const stack: { key: string | number | null; isArray: boolean; nextIndex: number }[] = []
      const rootField = opts?.rootField
      let seenRoot = false
      // Envelope skipping (rootField set): depth-0 siblings of the entries
      // object are ignored (scalars) or depth-counted without pushing
      // (containers), so their bytes never materialize.
      let skipDepth: number | null = null
      let enteredRoot = false
      let pendingKey: string | null = null
      let fileKey: string | null = null
      let elementCount = 0
      let arraySeen = false
      // Set once the array field's value arrives in any shape (array or
      // field-emitted): JSON objects never repeat keys, so a second one is
      // corrupt input and fails closed (JSON.parse would silently last-win).
      let arrayFieldSeen = false
      // Active token capture (one element or one metadata field at a time).
      let capture: { tokens: ParserToken[]; startDepth: number; kind: 'element' | 'field'; index: number; field: string } | null = null
      const fail = (msg: string): never => {
        throw new Error(`${msg}: ${path}`)
      }
      const stackPath = (): (string | number | null)[] => stack.map(frame => frame.key)
      for await (const token of tokens) {
        const { name } = token
        const value = 'value' in token ? (token.value as unknown) : undefined
        if (name === 'keyValue') {
          if (skipDepth !== null) continue
          if (typeof value !== 'string') fail('shard key is not a string')
          if (capture) capture.tokens.push(token)
          // Detach: this key flows into stack frames, file keys, field names
          // and map keys retained long-term (same SlicedString hazard as values).
          pendingKey = flatString(value as string)
          continue
        }
        if (START_TOKENS.has(name)) {
          if (!seenRoot) {
            if (stack.length !== 0 || pendingKey !== null || name !== 'startObject') fail('shard root is not an object')
            seenRoot = true
            continue
          }
          if (skipDepth !== null) {
            skipDepth++
            pendingKey = null
            continue
          }
          if (stack.length === 0 && rootField !== undefined && !enteredRoot) {
            // are depth-counted without pushing; the entries object itself
            // is entered without pushing so inner entries sit at depth 0.
            const key = pendingKey
            pendingKey = null
            if (key === rootField) {
              if (name !== 'startObject') fail(`shard field ${rootField} is not an object`)
              enteredRoot = true
            } else {
              skipDepth = 1
            }
            continue
          }
          const parent = stack.length === 0 ? null : stack[stack.length - 1]!
          const key = pendingKey ?? (parent?.isArray ? parent.nextIndex++ : null)
          pendingKey = null
          if (capture) capture.tokens.push(token)
          stack.push({ key, isArray: name === 'startArray', nextIndex: 0 })
          if (!capture) {
            const at = stackPath()
            if (at.length === 1) {
              if (typeof key !== 'string' || name !== 'startObject') fail('shard entry is not an object')
              fileKey = key as string
              elementCount = 0
              arraySeen = false
              arrayFieldSeen = false
              await cb.onFileStart?.(fileKey)
            } else if (at.length === 2) {
              if (at[1] === arrayField) {
                if (arrayFieldSeen) fail(`duplicate shard field ${arrayField}`)
                arrayFieldSeen = true
              }
              if (at[1] === arrayField && name === 'startArray') {
                arraySeen = true
              } else {
                // Nested object/array metadata field — or a non-array value
                // under the array field name, which the consumer judges
                // (session shards reject it; the codex scan keeps the entry).
                capture = { tokens: [token], startDepth: stack.length, kind: 'field', index: -1, field: at[1] as string }
              }
            } else if (at.length === 3 && at[1] === arrayField) {
              capture = { tokens: [token], startDepth: stack.length, kind: 'element', index: key as number, field: '' }
            } else {
              fail('shard entry has unexpected nesting')
            }
          }
          continue
        }
        if (SCALAR_TOKENS.has(name)) {
          if (skipDepth !== null) continue
          const parent = stack.length === 0 ? null : stack[stack.length - 1]!
          const key = pendingKey ?? (parent?.isArray ? parent.nextIndex++ : null)
          pendingKey = null
          if (capture) {
            capture.tokens.push(token)
            continue
          }
          const at = [...stackPath(), key]
          if (at.length === 1) {
            // Envelope sibling scalar (e.g. version) when scoped outside the
            // entries object; a file value otherwise, which is corrupt.
            if (rootField === undefined || enteredRoot) fail('shard entry is not an object')
            continue
          }
          // Scalars assemble through the same path as containers:
          // `numberValue` carries the lexeme as a string, so forwarding
          // `value` would turn every numeric field into a string.
          else if (at.length === 2) {
            if (at[1] === arrayField) {
              if (arrayFieldSeen) fail(`duplicate shard field ${arrayField}`)
              arrayFieldSeen = true
            }
            await cb.onField?.(fileKey!, at[1] as string, assembleTokens([token]))
          } else if (at.length === 3 && at[1] === arrayField) {
            await cb.onElement?.(fileKey!, key as number, assembleTokens([token]))
            elementCount++
          } else {
            fail('shard entry has unexpected nesting')
          }
          continue
        }
        if (name === 'endObject' || name === 'endArray') {
          if (skipDepth !== null) {
            skipDepth--
            if (skipDepth === 0) {
              skipDepth = null
              pendingKey = null
            }
            continue
          }
          if (stack.length === 0) {
            // Entries-object close when scoped (nothing was pushed for it),
            // else the root close (nothing was pushed for it either).
            if (name !== 'endObject') fail('shard root is not an object')
            enteredRoot = false
            continue
          }
          if (capture) {
            capture.tokens.push(token)
            if (stack.length === capture.startDepth) {
              const done = capture
              capture = null
              const assembled = assembleTokens(done.tokens)
              if (done.kind === 'element') {
                await cb.onElement?.(fileKey!, done.index, assembled)
                elementCount++
              } else {
                await cb.onField?.(fileKey!, done.field, assembled)
              }
            }
          }
          stack.pop()
          if (stack.length === 0 && fileKey !== null) {
            const doneKey = fileKey
            fileKey = null
            await cb.onFileEnd?.(doneKey, elementCount, arraySeen)
          }
          continue
        }
        fail(`shard has an unsupported token ${name}`)
      }
      if (capture || stack.length !== 0 || fileKey !== null) fail('shard ended mid-entry')
    },
  )
}
