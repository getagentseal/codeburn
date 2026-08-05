// Begin/End Synchronized Update (DEC private mode 2026); exported so callers
// can emit them; on Windows the filter below strips them from every write, so
// even a concatenated BSU+payload write cannot reach ConPTY (#195).
export const BSU = '\x1b[?2026h'
export const ESU = '\x1b[?2026l'
let patched = false

// split/join removes every occurrence and is hot-path cheap because the
// includes() gate below runs first.
export function stripSyncUpdateEscapes(chunk: string): string {
  return chunk.split(BSU).join('').split(ESU).join('')
}

export function patchStdoutForWindows(): void {
  if (process.platform !== 'win32' || patched) return
  patched = true

  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = function (chunk: unknown, ...args: unknown[]): boolean {
    // Non-string chunks pass straight through unchanged; Buffers never carry
    // these escapes in this codebase, so scanning them is not worth the copy.
    if (typeof chunk !== 'string') {
      return (origWrite as Function)(chunk, ...args)
    }
    // Neither escape present: pass straight through.
    if (!chunk.includes(BSU) && !chunk.includes(ESU)) {
      return (origWrite as Function)(chunk, ...args)
    }
    const stripped = stripSyncUpdateEscapes(chunk)
    if (stripped.length > 0) {
      return (origWrite as Function)(stripped, ...args)
    }
    // The chunk was swallowed entirely. The old exact-match filter dropped the
    // callback too, which could wedge a callback-style writer; invoke it
    // asynchronously so a caller awaiting the callback never hangs.
    const last = args[args.length - 1]
    if (typeof last === 'function') {
      queueMicrotask(() => (last as () => void)())
    }
    return true
  } as typeof process.stdout.write
}
