const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
let patched = false

export function patchStdoutForWindows(): void {
  if (process.platform !== 'win32' || patched) return
  patched = true

  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = function (chunk: unknown, ...args: unknown[]): boolean {
    if (chunk === BSU || chunk === ESU) return true
    return (origWrite as Function)(chunk, ...args)
  } as typeof process.stdout.write
}
