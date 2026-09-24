import { execFile } from 'node:child_process'
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const execFileAsync = promisify(execFile)

// The macOS keychain prompt (first read of an item `security` is not yet trusted
// for) blocks until the user answers. Give them time to click Allow before we
// give up - the old 10s kill fired while the dialog was still open and got
// misread as "disconnected".
export const KEYCHAIN_TIMEOUT_MS = 90_000

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
    .replace(/Bearer\s+[^\s,;"']+/gi, '[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
    // Google (ya29.) and GitHub (gho_/ghu_/ghp_) OAuth token shapes used by
    // the Gemini/Copilot quota providers.
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/gh[opusr]_[A-Za-z0-9_]+/g, '[REDACTED]')
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

/** Synchronous twin of {@link readSecureFile}, for the rotation path that must
 * not yield to the event loop between reading and writing a credential. */
export function readSecureFileSync(filePath: string, maxBytes = 64 * 1024): string | null {
  let before: Stats
  try {
    before = lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (before.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${filePath}`)
  assertSafeMode(before, filePath)
  if (before.size > maxBytes) throw new Error(`Credential file exceeds ${maxBytes} bytes: ${filePath}`)

  const fd = openSync(filePath, constants.O_RDONLY | NOFOLLOW)
  try {
    const after = fstatSync(fd)
    assertSafeMode(after, filePath)
    if (after.dev !== before.dev || after.ino !== before.ino) throw new Error(`Credential file changed while opening: ${filePath}`)
    if (after.size > maxBytes) throw new Error(`Credential file exceeds ${maxBytes} bytes: ${filePath}`)
    return readFileSync(fd, { encoding: 'utf8' })
  } finally {
    closeSync(fd)
  }
}

// Rewrite a credential with exactly the owner-only permissions it already had,
// so a refreshed token neither widens the file the user chose nor drops a
// tighter mode like 0o400. Group or world bits (or Windows, where mode bits are
// not the access control) mean there is nothing safe to copy: use owner rw.
function privateModeFor(filePath: string): number {
  if (process.platform === 'win32') return 0o600
  try {
    const stats = lstatSync(filePath)
    if (!stats.isFile()) return 0o600
    const mode = stats.mode & 0o777
    return mode !== 0 && (mode & 0o077) === 0 ? mode : 0o600
  } catch {
    return 0o600
  }
}

/**
 * Writes a credential file atomically and synchronously. Synchronous on
 * purpose: a caller holding a freshly rotated token has to get it onto disk
 * without an await for an abort, a timeout or a `process.exit` to land in.
 */
export function atomicWriteSecureFileSync(filePath: string, contents: string): void {
  const mode = privateModeFor(filePath)
  const dir = path.dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  try {
    const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
    try {
      writeFileSync(fd, contents, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (process.platform !== 'win32') chmodSync(tempPath, mode)
    renameSync(tempPath, filePath)
  } catch (error) {
    try { unlinkSync(tempPath) } catch { /* nothing to clean up */ }
    throw error
  }
}

/// How long a quota request, including a token grant, is given to answer.
export const QUOTA_REQUEST_TIMEOUT_MS = 30_000

export function quotaRequestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

/// Refreshes that have left this machine and whose result is not yet on disk.
///
/// A token grant retires the refresh token in the credential file the instant
/// the server accepts it, so the window between the POST and the rewritten file
/// is one where quitting costs the user their login. Nothing cancels that
/// window - the request deliberately ignores the caller's abort signal - but a
/// `process.exit` will still cut through it, so any command that exits outright
/// has to drain this first.
const outstandingCredentialWrites = new Set<Promise<void>>()

/// Past this an exit stops waiting. It has to outlast the request it is waiting
/// on, or the guard expires while the very case it was built for is still in
/// flight: a grant answering at twenty seconds is exactly the slow reply that
/// costs the user their login. Derived from the request timeout rather than
/// written as a number, so the two cannot drift apart, plus a margin for the
/// write that follows the reply.
export const CREDENTIAL_DRAIN_TIMEOUT_MS = QUOTA_REQUEST_TIMEOUT_MS + 5_000

/** Registers a rotation for {@link awaitCredentialWrites} to wait on. Returns
 * the same promise, so a caller can keep awaiting it exactly as before. */
export function trackCredentialWrite<T>(work: Promise<T>): Promise<T> {
  // Swallowed here only: the tracked copy exists to be waited on, and the
  // caller still sees the original promise's rejection.
  const settled = work.then(() => undefined, () => undefined)
  outstandingCredentialWrites.add(settled)
  void settled.then(() => { outstandingCredentialWrites.delete(settled) })
  return work
}

export function pendingCredentialWrites(): number {
  return outstandingCredentialWrites.size
}

/** Waits for every registered rotation to reach disk, up to `timeoutMs`. Safe
 * to call when there is nothing outstanding, which is the usual case. */
export async function awaitCredentialWrites(timeoutMs = CREDENTIAL_DRAIN_TIMEOUT_MS): Promise<void> {
  if (outstandingCredentialWrites.size === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  try {
    // Looped rather than snapshotted once: a 401 retry can start a second
    // rotation while the first is still draining.
    while (outstandingCredentialWrites.size > 0) {
      const drained = Promise.all([...outstandingCredentialWrites]).then(() => 'drained' as const)
      if (await Promise.race([drained, expired]) === 'timeout') {
        // Giving up here can retire a login, so it is said out loud rather than
        // left for the user to discover the next time a provider asks them to
        // sign in again.
        process.stderr.write(
          'codeburn: a provider login was still being refreshed after '
          + `${Math.round(timeoutMs / 1000)}s and was not saved. `
          + 'If that provider signs you out, sign in again with its own CLI.\n',
        )
        return
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function fraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value / 100))
}
