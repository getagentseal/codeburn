import { execFile } from 'node:child_process'
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs'
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
 * needs the user to grant access; `reason` says when that was the user's own
 * answer to a prompt (Deny, or the dialog left open until the timeout). */
export type KeychainOutcome =
  | { status: 'found'; value: string }
  | { status: 'notFound' }
  | { status: 'accessDenied'; reason?: KeychainRefusal }

export type KeychainRefusal = 'denied' | 'unanswered'

export type KeychainExec = (
  file: string,
  args: string[],
  options: { signal: AbortSignal; maxBuffer: number },
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

// exit 44 / "could not be found" is a genuine miss. A Deny (exit 128, "User
// canceled") and our own timer firing while the dialog waited are the user's
// answer to a prompt. Anything else (interaction not allowed, I/O, a kill or
// crash we did not cause) means access wasn't granted, but showed no prompt,
// so the next candidate is tried.
function classifyKeychainError(error: unknown, timedOut: boolean): 'notFound' | 'denied' | 'unanswered' | 'other' {
  if (timedOut) return 'unanswered'
  const err = error as { code?: number | string; stderr?: string; message?: string }
  const code = typeof err.code === 'number' || typeof err.code === 'string' ? Number(err.code) : undefined
  const text = `${err.stderr ?? ''} ${err.message ?? ''}`.toLowerCase()
  if (code === 44 || text.includes('could not be found') || text.includes('specified item could not be found')) {
    return 'notFound'
  }
  if (code === 128 || text.includes('user canceled')) return 'denied'
  return 'other'
}

// Items (service plus account) the user refused since the last user-initiated
// refresh, which clears them: one prompt per item per action, never persisted.
const refusedThisRun = new Map<string, KeychainRefusal>()

export function forgetKeychainRefusals(): void {
  refusedThisRun.clear()
}

/**
 * Reads a generic-password keychain item via the Apple-signed `/usr/bin/security`
 * (which the item's `apple-tool:` partition trusts, avoiding the partition-list
 * prompt on already-consented items). Tries each account candidate in order
 * (`null` = service-only) and stops at a Deny or an unanswered prompt: a later
 * candidate can match the same item, and asking again is a second prompt the
 * user already answered. A refused item is skipped (with the service-only
 * lookup) until {@link forgetKeychainRefusals}. Never returns or logs the
 * secret to any caller but the direct one.
 */
export async function readKeychainPassword(
  service: string,
  accounts: (string | null)[] = [null],
  exec: KeychainExec = execFileAsync,
): Promise<KeychainOutcome> {
  if (process.platform !== 'darwin') return { status: 'notFound' }
  let denied = false
  let refusal: KeychainRefusal | undefined
  for (const account of accounts) {
    const item = JSON.stringify([service, account])
    const remembered = refusedThisRun.get(item)
    if (remembered) { refusal = remembered; continue }
    const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, KEYCHAIN_TIMEOUT_MS)
    try {
      const { stdout } = await exec('/usr/bin/security', args, { signal: controller.signal, maxBuffer: 64 * 1024 })
      if (stdout && stdout.trim()) return { status: 'found', value: decodeKeychainValue(stdout) }
    } catch (error) {
      const kind = classifyKeychainError(error, timedOut)
      if (kind === 'denied' || kind === 'unanswered') {
        refusedThisRun.set(item, kind)
        // A later service-only lookup can match the refused item and ask again.
        refusedThisRun.set(JSON.stringify([service, null]), kind)
        return { status: 'accessDenied', reason: kind }
      }
      if (kind === 'other') denied = true
    } finally {
      clearTimeout(timer)
    }
  }
  if (refusal) return { status: 'accessDenied', reason: refusal }
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
 * without an await for an abort, a timeout or a quit to land in.
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
