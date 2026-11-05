import { createHash, randomBytes } from 'crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'fs/promises'
import { dirname, join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'

// What a transcript yields for a request that would otherwise re-read it, kept
// per file and per file version so a period becomes a walk over stored facts.
// The facts are computed when written, so a change to any rule that produces
// them must bump this number, or old facts keep answering under the new rule:
//   corrections: scanFileCorrections, extractText, SELF_CORRECTION_PATTERNS (compare-stats.ts)
//   optimize: scanFileRecord, compactOptimizeInput, commandNames, the opener
//     rules, storeScan/loadScan and their caps (optimize.ts), isReadShapedBashCommand
//     (bash-utils.ts), parseJsonlLine/parseLargeJsonl (parser.ts)
// tests/scan-facts-version.test.ts pins those sources to this number.
export const FACTS_VERSION = 1

// The digest of a file's first bytes as of the stored offset: the proof that the
// bytes already read are still the same bytes before only the new ones are read.
const HEAD_BYTES = 4096
// Only a file written this recently is worth the digest a resumed read needs; an
// older file that grows is simply read again in full.
const RESUMABLE_AGE_MS = 24 * 60 * 60 * 1000

type FactRow<T> = {
  path: string
  size: number
  mtimeMs: number
  /// The byte after the last complete line read, where a resumed read starts.
  offset: number
  head: string
  facts: T
}

export type FactsPass<T> = { facts: T; offset: number }
export type FactsResume<T> = { fromOffset: number; facts: T }

export function factsDir(): string {
  return join(getCodeburnCacheDir(), `scan-facts.v${FACTS_VERSION}`)
}

function factPath(kind: string, filePath: string): string {
  return join(factsDir(), kind, `${createHash('sha1').update(filePath).digest('hex')}.json`)
}

export async function headDigest(filePath: string): Promise<string | null> {
  let handle: FileHandle
  try {
    handle = await open(filePath, 'r')
  } catch { return null }
  try {
    const buffer = Buffer.allocUnsafe(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

async function readRow<T>(target: string, filePath: string): Promise<FactRow<T> | null> {
  try {
    const row = JSON.parse(await readFile(target, 'utf-8')) as FactRow<T>
    return row.path === filePath ? row : null
  } catch { return null }
}

// The content is a function of the file's bytes alone, so two processes writing
// the same row race harmlessly: the rename makes either one whole.
async function writeRow<T>(target: string, row: FactRow<T>): Promise<void> {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(tmp, JSON.stringify(row), 'utf-8')
    await rename(tmp, target)
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/// The stored facts of one file when its size and mtime still match; otherwise
/// `scan` produces them, from the stored offset when the file only grew past an
/// unchanged head, and the result is stored for the next request.
export async function fileFacts<T>(
  kind: string,
  filePath: string,
  scan: (resume?: FactsResume<T>) => Promise<FactsPass<T>>,
): Promise<T> {
  let size: number
  let mtimeMs: number
  try {
    ({ size, mtimeMs } = await stat(filePath))
  } catch {
    return (await scan()).facts
  }
  const target = factPath(kind, filePath)
  const row = await readRow<T>(target, filePath)
  if (row && row.size === size && row.mtimeMs === mtimeMs) return row.facts

  let resume: FactsResume<T> | undefined
  if (row && row.head !== '' && size > row.size && row.offset <= size && await headDigest(filePath) === row.head) {
    resume = { fromOffset: row.offset, facts: row.facts }
  }
  const pass = await scan(resume)
  const mayGrow = Date.now() - mtimeMs < RESUMABLE_AGE_MS
  const head = resume ? row!.head : mayGrow ? await headDigest(filePath) : ''
  if (head !== null) await writeRow(target, { path: filePath, size, mtimeMs, offset: pass.offset, head, facts: pass.facts })
  return pass.facts
}
