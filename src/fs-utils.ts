import { readFile, stat } from 'fs/promises'
import { readFileSync, statSync, createReadStream } from 'fs'

// Hard cap well below V8's 512 MB string limit. Callers that need line-by-line
// processing should use readSessionLines(), which avoids materializing the
// whole file and can return large lines as Buffers.
export const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024
export const LARGE_STREAM_LINE_BYTES = 32 * 1024

// Line-by-line streaming has bounded memory (one line at a time) and is not
// constrained by V8's string limit, so it can safely handle multi-GB session
// files. Heavy Codex sessions routinely reach several GB (image-heavy compacted
// turns), so the cap is generous and exists only to guard against truly
// pathological inputs. When a file IS skipped, notice() surfaces it (always on,
// not verbose-gated) so a dropped session never silently understates usage.
export const MAX_STREAM_SESSION_FILE_BYTES = 4 * 1024 * 1024 * 1024

function verbose(): boolean {
  return process.env.CODEBURN_VERBOSE === '1'
}

function warn(msg: string): void {
  if (verbose()) process.stderr.write(`codeburn: ${msg}\n`)
}

// Always surfaced (not verbose-gated): dropping an entire session file silently
// understates reported usage with no signal, so oversize skips use this.
function notice(msg: string): void {
  process.stderr.write(`codeburn: ${msg}\n`)
}

export async function readSessionFile(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<string | null> {
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
    return await readFile(filePath, encoding)
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

export type SessionLine = string | Buffer

type ReadSessionLinesOptions = {
  largeLineAsBuffer?: boolean
  largeLineThresholdBytes?: number
  startByteOffset?: number
  byteOffsetTracker?: { lastCompleteLineOffset: number }
  maxBytes?: number
}

export function readSessionLines(
  filePath: string,
  shouldSkipHead?: (head: string) => boolean,
): AsyncGenerator<string>
export function readSessionLines(
  filePath: string,
  shouldSkipHead?: (head: string) => boolean,
  options?: ReadSessionLinesOptions & { largeLineAsBuffer: true },
): AsyncGenerator<SessionLine>
export async function* readSessionLines(
  filePath: string,
  shouldSkipHead?: (head: string) => boolean,
  options: ReadSessionLinesOptions = {},
): AsyncGenerator<SessionLine> {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (err) {
    warn(`stat failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return
  }

  const maxBytes = options.maxBytes ?? MAX_STREAM_SESSION_FILE_BYTES
  if (size > maxBytes) {
    notice(
      `skipped oversize session ${filePath} (${size} bytes > cap ${maxBytes}); its usage is NOT counted`,
    )
    return
  }

  const stream = createReadStream(
    filePath,
    options.startByteOffset !== undefined ? { start: options.startByteOffset } : undefined,
  )
  const SKIP_HEAD = 2048
  const largeLineThreshold = options.largeLineThresholdBytes ?? LARGE_STREAM_LINE_BYTES
  const formatLine = (buf: Buffer, lineLen: number, head?: string): SessionLine => {
    if (options.largeLineAsBuffer && lineLen > largeLineThreshold) return buf
    return head !== undefined && lineLen <= SKIP_HEAD ? head : buf.toString('utf-8')
  }
  let parts: Buffer[] = []
  let len = 0
  let skipping = false
  let headChecked = false
  let chunkBase = options.startByteOffset ?? 0
  const tracker = options.byteOffsetTracker

  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer
      let pos = 0

      while (pos < chunk.length) {
        const nl = chunk.indexOf(0x0a, pos)

        if (skipping) {
          if (nl === -1) {
            pos = chunk.length
          } else {
            if (tracker) tracker.lastCompleteLineOffset = chunkBase + nl + 1
            skipping = false
            pos = nl + 1
          }
          continue
        }

        if (nl !== -1) {
          if (pos < nl) {
            parts.push(chunk.subarray(pos, nl))
            len += nl - pos
          }
          pos = nl + 1
          if (tracker) tracker.lastCompleteLineOffset = chunkBase + pos

          if (len === 0) {
            parts = []
            headChecked = false
            continue
          }

          const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, len)
          const lineLen = len
          parts = []
          len = 0
          headChecked = false

          if (shouldSkipHead) {
            const head = lineLen > SKIP_HEAD
              ? buf.subarray(0, SKIP_HEAD).toString('utf-8')
              : buf.toString('utf-8')
            if (shouldSkipHead(head)) continue
            yield formatLine(buf, lineLen, head)
          } else {
            yield formatLine(buf, lineLen)
          }
        } else {
          const slice = chunk.subarray(pos)
          parts.push(slice)
          len += slice.length
          pos = chunk.length

          // Mid-line skip: once we have enough bytes to check the head,
          // enter scanning mode — just look for \n without accumulating.
          if (shouldSkipHead && !headChecked && len >= SKIP_HEAD) {
            headChecked = true
            const headBuf = parts.length === 1
              ? parts[0]!.subarray(0, SKIP_HEAD)
              : Buffer.concat(parts, len).subarray(0, SKIP_HEAD)
            if (shouldSkipHead(headBuf.toString('utf-8'))) {
              skipping = true
              parts = []
              len = 0
            }
          }
        }
      }
      chunkBase += chunk.length
    }

    if (!skipping && len > 0) {
      const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, len)
      const lineLen = len
      if (shouldSkipHead) {
        const head = lineLen > SKIP_HEAD
          ? buf.subarray(0, SKIP_HEAD).toString('utf-8')
          : buf.toString('utf-8')
        if (!shouldSkipHead(head)) {
          yield formatLine(buf, lineLen, head)
        }
      } else {
        yield formatLine(buf, lineLen)
      }
    }
  } catch (err) {
    warn(`stream read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
  } finally {
    stream.destroy()
  }
}
