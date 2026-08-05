// Host privacy key (decision D1). A random 32-byte key, generated once and
// persisted in the codeburn config dir alongside config.json, that scopes every
// resource fingerprint. Keeping it stable across runs makes resourceIds stable
// (so the same file always fingerprints the same way); regenerating it would
// scramble them. The key is NEVER printed and NEVER leaves the host — only the
// HMAC fingerprints it produces cross into any payload.
//
// Read synchronously (and cached) because the optimize detectors that need it
// are synchronous. This mirrors config.ts's storage location while staying on
// the sync fs API those detectors require.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

import { getConfigDir } from './config.js'

const KEY_FILE = 'privacy-key'
const KEY_HEX = /^[0-9a-f]{64}$/

let cached: string | undefined

function keyPath(): string {
  return join(getConfigDir(), KEY_FILE)
}

/**
 * State of the key file, without creating anything. The distinction that
 * matters: 'missing' (no file at all — a first use, which may create one)
 * versus 'unreadable'/'invalid' (a file that EXISTS but does not contain a
 * usable key — a corrupt file, which must never be silently replaced). A
 * zero-byte file or a file that fails to read is a partial write / disk
 * failure, not an absent key.
 */
type KeyFileState =
  | { kind: 'missing' }
  | { kind: 'valid'; key: string }
  | { kind: 'unreadable' }
  | { kind: 'invalid' }

function readKeyFileState(path: string): KeyFileState {
  if (!existsSync(path)) return { kind: 'missing' }

  let raw = ''
  try {
    raw = readFileSync(path, 'utf-8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    // Exists but unreadable (EACCES, EIO, ...). Corrupt for our purposes.
    return { kind: 'unreadable' }
  }
  if (KEY_HEX.test(raw)) return { kind: 'valid', key: raw }
  // Exists but empty, whitespace-only, or not 64 hex chars. A zero-byte file
  // is a partial write — corrupt, not missing.
  return { kind: 'invalid' }
}

/** Synchronous sleep for the bounded EEXIST re-read retry below. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Bounded wait for a concurrent first-use winner's key to land. The winner's
 * create (open) and write are separate syscalls — between them the file exists
 * but is empty — and under scheduler pressure that gap can exceed the 50ms the
 * original EEXIST loop allowed. 500ms keeps the wait bounded (a crashed winner
 * leaves an empty file forever, so the corruption refusal stays reachable)
 * while making adoption robust on a loaded machine.
 */
const ADOPTION_WAIT_MS = 500
const ADOPTION_POLL_MS = 50

function awaitValidKey(path: string): string | null {
  const deadline = Date.now() + ADOPTION_WAIT_MS
  while (Date.now() < deadline) {
    const state = readKeyFileState(path)
    if (state.kind === 'valid') return state.key
    sleepSync(ADOPTION_POLL_MS)
  }
  return null
}

/**
 * Outcome of an exclusive first-use create.
 */
type FirstUseOutcome =
  | { kind: 'key'; key: string } // created by us, or adopted from a concurrent winner
  | { kind: 'invalid-existing' } // a concurrent create won but left no valid key (crashed mid-write)
  | { kind: 'write-failed' }     // mkdir or write failed for another reason (unwritable dir)

/**
 * Create the key file with O_CREAT|O_EXCL so exactly one concurrent first use
 * wins. A non-exclusive write would let two processes mint different keys and
 * each cache its own — then device ids derived under one key mix with spans
 * derived under the other. Losers re-read and adopt the winner's key. The
 * winner's write lands immediately after its create, so on EEXIST we retry a
 * bounded number of times before concluding the file was left by a crash.
 */
function createKeyFileExclusive(path: string): FirstUseOutcome {
  const key = randomBytes(32).toString('hex')
  try {
    mkdirSync(getConfigDir(), { recursive: true })
    writeFileSync(path, key + '\n', { mode: 0o600, flag: 'wx' })
    return { kind: 'key', key }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { kind: 'write-failed' }
    }
    // Loser of the create race: adopt the winner's key once its write lands
    // (the file exists but may still be empty; see awaitValidKey).
    const adopted = awaitValidKey(path)
    if (adopted) return { kind: 'key', key: adopted }
    return { kind: 'invalid-existing' }
  }
}

/**
 * Return the host privacy key, generating and persisting one on first use.
 * Falls back to an in-memory ephemeral key if the config dir is unwritable, so
 * a read-only environment still gets stable (per-process) fingerprints rather
 * than throwing.
 *
 * An existing key file that is unreadable, empty, or fails hex validation is
 * likewise NEVER overwritten: the caller gets an ephemeral key and the file is
 * left alone, so {@link getPersistedHostPrivacyKey} can still detect the
 * corruption and fail loudly instead of finding a freshly regenerated key.
 * 'No file at all' is the ONLY state that may create one.
 *
 * First creation is exclusive, so concurrent first uses converge on one key
 * instead of each minting (and overwriting) its own.
 *
 * This tolerance is CORRECT only for consumers whose fingerprints need
 * per-process stability (the optimize detectors). Sync ids need CROSS-PROCESS
 * stability — use {@link getPersistedHostPrivacyKey} there instead.
 */
export function getHostPrivacyKey(): string {
  if (cached) return cached

  const path = keyPath()
  const state = readKeyFileState(path)
  if (state.kind === 'valid') {
    cached = state.key
    return cached
  }
  if (state.kind !== 'missing') {
    // The file exists but is not a usable key (corrupt content, empty partial
    // write, or unreadable). Never overwrite it: that would silently re-key
    // every fingerprint id derived from the old key. Fall back to an ephemeral
    // key so optimize detectors keep per-process stability, and leave the file
    // untouched so getPersistedHostPrivacyKey still detects the corruption and
    // fails loudly.
    cached = randomBytes(32).toString('hex')
    return cached
  }

  const outcome = createKeyFileExclusive(path)
  if (outcome.kind === 'key') {
    cached = outcome.key
    return cached
  }
  // Unwritable dir, or a concurrent first use crashed before writing a key.
  // Keep the key in memory for this process only; never clobber the file.
  cached = randomBytes(32).toString('hex')
  return cached
}

/**
 * Like {@link getHostPrivacyKey}, but REQUIRES a persisted key and fails
 * loudly instead of degrading to per-process randomness. Sync uses this: its
 * device/span/trace ids must be byte-identical across processes — the
 * partial-rejection retry guarantee in sync/push.ts depends on it — so an
 * ephemeral key (which would emit fresh ids on every push) is worse than no
 * push at all.
 *
 * It also refuses to silently regenerate a key file that exists but does not
 * hold a valid key — corrupt content, a zero-byte partial write, or an
 * unreadable file. Overwriting any of those would re-key every id with no
 * notice, silently orphaning whatever was already pushed to the backend. The
 * operator must see the corruption and decide — fix the disk, or delete the
 * file deliberately. Only 'no file at all' may be created, and that first
 * create is exclusive so concurrent first pushes converge on one key.
 */
export function getPersistedHostPrivacyKey(): string {
  const path = keyPath()

  const state = readKeyFileState(path)
  if (state.kind === 'valid') {
    cached = state.key
    return cached
  }
  if (state.kind === 'unreadable') {
    throw new Error(
      `Host privacy key at ${path} exists but could not be read. ` +
      'Refusing to overwrite it: that would silently re-key every id and orphan ' +
      'already-synced data. Fix the disk or file permissions, or delete the file ' +
      'deliberately, then retry.'
    )
  }
  if (state.kind === 'invalid') {
    // A concurrent first use may be mid-write (file created, key not yet
    // written): wait a bounded window and ADOPT the winner's key when it
    // lands — the loser never mints its own. A file that stays invalid (a
    // crash, a truncated write) still gets the refusal below; nothing is
    // ever overwritten.
    const adopted = awaitValidKey(path)
    if (adopted) {
      cached = adopted
      return cached
    }
    throw new Error(
      `Host privacy key at ${path} is corrupted (expected 64 hex chars). ` +
      'Refusing to overwrite it: that would silently re-key every id and orphan ' +
      'already-synced data. Fix the disk or delete the file deliberately, then retry.'
    )
  }

  const outcome = createKeyFileExclusive(path)
  if (outcome.kind === 'key') {
    cached = outcome.key
    return cached
  }
  if (outcome.kind === 'invalid-existing') {
    // A concurrent first use created the file but crashed before writing a
    // valid key. The file exists and holds no key — same refusal as above.
    throw new Error(
      `Host privacy key at ${path} exists but does not contain a valid key ` +
      '(a concurrent first use left it empty). Refusing to overwrite it: that would ' +
      'silently re-key every id and orphan already-synced data. Delete the file ' +
      'deliberately, then retry.'
    )
  }
  throw new Error(
    `Cannot persist a host privacy key at ${path} (config dir not writable). ` +
    'Sync requires a stable on-disk key so ids are identical across pushes; ' +
    'an in-memory key would change every id on the next run. Fix permissions and retry.'
  )
}
