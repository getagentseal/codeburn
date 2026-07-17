import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const execFileAsync = promisify(execFile)

// The macOS keychain prompt (first read of an item `security` is not yet trusted
// for) blocks until the user answers. Give them time to click Allow before we
// give up — the old 10s kill fired while the dialog was still open and got
// misread as "disconnected".
const KEYCHAIN_TIMEOUT_MS = 90_000

/** Outcome of a keychain lookup. `accessDenied` means the item exists but macOS
 * needs the user to grant access (dialog dismissed, denied, or not answered). */
export type KeychainOutcome =
  | { status: 'found'; value: string }
  | { status: 'notFound' }
  | { status: 'accessDenied' }

export type KeychainExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>

// `security -w` hex-encodes password data it can't hand back as a clean C-string
// (Claude Code line-wraps its JSON blob, which triggers this). Real credential
// JSON always contains non-hex characters like '{' and '"', so an all-hex,
// even-length payload is unambiguously a hex dump we must decode.
function decodeKeychainValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex').toString('utf8')
  }
  return raw
}

// exit 44 / "could not be found" is a genuine miss; anything else non-zero
// (interaction not allowed, user canceled/denied, or a timeout kill while the
// dialog waited) means the item is there but access wasn't granted.
function classifyKeychainError(error: unknown): 'notFound' | 'accessDenied' {
  const err = error as { code?: number | string; stderr?: string; message?: string }
  const code = typeof err.code === 'number' ? err.code : undefined
  const text = `${err.stderr ?? ''} ${err.message ?? ''}`.toLowerCase()
  if (code === 44 || text.includes('could not be found') || text.includes('specified item could not be found')) {
    return 'notFound'
  }
  return 'accessDenied'
}

/**
 * Reads a generic-password keychain item via the Apple-signed `/usr/bin/security`
 * (which the item's `apple-tool:` partition trusts, avoiding the partition-list
 * prompt on already-consented items). Tries each account candidate in order
 * (`null` = service-only). Never returns or logs the secret to any caller but
 * the direct one.
 */
export async function readKeychainPassword(
  service: string,
  accounts: (string | null)[] = [null],
  exec: KeychainExec = execFileAsync,
): Promise<KeychainOutcome> {
  if (process.platform !== 'darwin') return { status: 'notFound' }
  let denied = false
  for (const account of accounts) {
    const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']
    try {
      const { stdout } = await exec('/usr/bin/security', args, { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024 })
      if (stdout && stdout.trim()) return { status: 'found', value: decodeKeychainValue(stdout) }
    } catch (error) {
      if (classifyKeychainError(error) === 'accessDenied') denied = true
    }
  }
  return denied ? { status: 'accessDenied' } : { status: 'notFound' }
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/\0/g, '')
    .replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED]')
    .slice(0, 240)
}

function assertSafeMode(stats: Stats, filePath: string): void {
  if (!stats.isFile()) throw new Error(`Credential path is not a regular file: ${filePath}`)
  // POSIX mode bits are meaningless for Windows ACLs, where stats.mode would
  // otherwise reject every credential file.
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) throw new Error(`Credential file permissions are too broad: ${filePath}`)
}

export async function readSecureFile(filePath: string, maxBytes = 64 * 1024): Promise<string | null> {
  let before: Stats
  try {
    before = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (before.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${filePath}`)
  assertSafeMode(before, filePath)
  if (before.size > maxBytes) throw new Error(`Credential file exceeds ${maxBytes} bytes: ${filePath}`)

  const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW)
  try {
    const after = await handle.stat()
    assertSafeMode(after, filePath)
    if (after.dev !== before.dev || after.ino !== before.ino) throw new Error(`Credential file changed while opening: ${filePath}`)
    if (after.size > maxBytes) throw new Error(`Credential file exceeds ${maxBytes} bytes: ${filePath}`)
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

export async function atomicWriteSecureFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
  await handle.close()
  await chmod(tempPath, 0o600)
  try {
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

export function quotaRequestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

export function fraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value / 100))
}
