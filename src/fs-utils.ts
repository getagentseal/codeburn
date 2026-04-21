import { readFile, stat } from 'fs/promises'
import { readFileSync, statSync, createReadStream } from 'fs'
import { createInterface } from 'readline'

// Hard cap well below V8's 512 MB string limit even with split('\n') doubling.
// Stream threshold chosen as empirical breakeven between readFile+split peak
// memory and createReadStream+readline overhead for typical session files.
export const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024
export const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024

function verbose(): boolean {
  return process.env.CODEBURN_VERBOSE === '1'
}

function warn(msg: string): void {
  if (verbose()) process.stderr.write(`codeburn: ${msg}\n`)
}

async function readViaStream(filePath: string): Promise<string> {
  const chunks: string[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) chunks.push(line)
  return chunks.join('\n')
}

export async function readSessionFile(filePath: string): Promise<string | null> {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (err) {
    warn(`stat failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }

  if (size > MAX_SESSION_FILE_BYTES) {
    warn(`skipped oversize file ${filePath} (${size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
    return null
  }

  try {
    if (size >= STREAM_THRESHOLD_BYTES) return await readViaStream(filePath)
    return await readFile(filePath, 'utf-8')
  } catch (err) {
    warn(`read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }
}

export function readSessionFileSync(filePath: string): string | null {
  let size: number
  try {
    size = statSync(filePath).size
  } catch (err) {
    warn(`stat failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }

  if (size > MAX_SESSION_FILE_BYTES) {
    warn(`skipped oversize file ${filePath} (${size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
    return null
  }

  try {
    return readFileSync(filePath, 'utf-8')
  } catch (err) {
    warn(`read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }
}

export async function* readSessionLines(filePath: string): AsyncGenerator<string> {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (err) {
    warn(`stat failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return
  }

  if (size > MAX_SESSION_FILE_BYTES) {
    warn(`skipped oversize file ${filePath} (${size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
    return
  }

  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) yield line
  } catch (err) {
    warn(`stream read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
  } finally {
    stream.destroy()
  }
}
