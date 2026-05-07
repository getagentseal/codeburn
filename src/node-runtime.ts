export const MIN_NODE_VERSION = { major: 22, minor: 13, patch: 0 } as const

type NodeVersion = {
  major: number
  minor: number
  patch: number
}

export function parseNodeVersion(raw: string = process.version): NodeVersion | null {
  const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function isSupportedNodeVersion(raw: string = process.version): boolean {
  const parsed = parseNodeVersion(raw)
  if (!parsed) return false
  if (parsed.major !== MIN_NODE_VERSION.major) return parsed.major > MIN_NODE_VERSION.major
  if (parsed.minor !== MIN_NODE_VERSION.minor) return parsed.minor > MIN_NODE_VERSION.minor
  return parsed.patch >= MIN_NODE_VERSION.patch
}

export function formatUnsupportedNodeMessage(raw: string = process.version): string {
  const min = `${MIN_NODE_VERSION.major}.${MIN_NODE_VERSION.minor}.${MIN_NODE_VERSION.patch}`
  return [
    `codeburn requires Node.js ${min} or newer; current runtime is ${raw}.`,
    'Please upgrade Node.js and run codeburn again.',
    'This version is required because CodeBurn depends on modern terminal packages and Node\'s unflagged node:sqlite module for SQLite-backed providers.',
  ].join('\n')
}

export function assertSupportedNodeVersion(raw: string = process.version): void {
  if (isSupportedNodeVersion(raw)) return
  process.stderr.write(formatUnsupportedNodeMessage(raw) + '\n')
  process.exit(1)
}
