import { constants } from 'fs'
import { access } from 'fs/promises'
import { delimiter, join } from 'path'

export const PERSISTENT_CLI_REQUIRED_MESSAGE =
  'CodeBurn needs a persistent codeburn command. Install CodeBurn globally first: npm install -g codeburn'

const DEFAULT_CLI_LOOKUP_PATHS = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function buildPersistentCodeburnLookupPath(existingPath = process.env.PATH ?? ''): string {
  const parts = existingPath.split(delimiter).filter(Boolean)
  for (const fallback of DEFAULT_CLI_LOOKUP_PATHS) {
    if (!parts.includes(fallback)) parts.push(fallback)
  }
  return parts.join(delimiter)
}

export function isTransientNpxPath(path: string): boolean {
  return path.includes('/_npx/') || path.includes('/.npm/_npx/') || path.includes('\\_npx\\')
}

function codeburnExecutableNames(): string[] {
  if (process.platform !== 'win32') return ['codeburn']
  return ['codeburn.cmd', 'codeburn.exe', 'codeburn.bat', 'codeburn']
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.F_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolvePersistentCodeburnPathFromPath(
  lookupPath: string,
  message: string = PERSISTENT_CLI_REQUIRED_MESSAGE,
): Promise<string> {
  const seen = new Set<string>()
  for (const dir of lookupPath.split(delimiter).filter(Boolean)) {
    for (const executable of codeburnExecutableNames()) {
      const candidate = join(dir, executable)
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (isTransientNpxPath(candidate)) continue
      if (await executableExists(candidate)) return candidate
    }
  }
  throw new Error(message)
}

export function resolvePersistentCodeburnPathFromWhichOutput(
  output: string,
  message: string = PERSISTENT_CLI_REQUIRED_MESSAGE,
): string {
  const paths = output
    .split(/\r?\n/)
    .map(path => path.trim())
    .filter(Boolean)
  const persistentPath = paths.find(path => path.startsWith('/') && !isTransientNpxPath(path))
  if (persistentPath) return persistentPath
  throw new Error(message)
}
