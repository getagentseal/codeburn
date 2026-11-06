// Live ZCode (z.ai coding plan) quota via the same usage endpoint the ZCode
// app's embedded coding-plan browser calls — the sibling of ./zai.ts, which
// serves the Pi CLI login; this one serves the ZCode desktop app's own login:
//
// - GET https://api.z.ai/api/monitor/usage/quota/limit
//     Bearer token. The body can carry a business-level code (401/403) even on
//     HTTP 200 — and that code is the ONLY expiry signal, because the JWT ZCode
//     stores carries no exp claim at all.
//
// Credential: the z.ai OAuth token in the coding-plan webview's Chromium
// Local Storage journal (…/ZCode/session/Partitions/zcode-coding-plan/
// Local Storage/leveldb/*.log), under the key `oauth:zai:access_token`.
// Read-only; the token is used for one request and never persisted or logged.
// Chromium owns that file's mode bits (group-readable by design), so this is a
// plain capped read rather than readSecureFile, which rejects such modes.
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, sanitizeError } from './security.js'
import { decodeZaiPlanUsage } from './zai-plan.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit'
const STORAGE_KEY = 'oauth:zai:access_token'
const SOURCE_FOOTER = ['Source: Z.ai Coding Plan']
const EXPIRED_FOOTER = ['Login expired. Open the ZCode app and sign in again, then refresh.']
const RATE_LIMITED_FOOTER = ['Z.ai rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Z.ai is temporarily unavailable.']
const PARSE_FOOTER = ['Z.ai returned an unrecognized quota response.']

/** Journals are small; anything huge is not a Local Storage log and is skipped. */
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024

export type ZcodeDeps = {
  fetch: typeof fetch
  /** The coding-plan webview's Local Storage leveldb directory. */
  storageDir: string
  readDir: (dir: string) => Promise<string[]>
  readJournal: (filePath: string) => Promise<Buffer | null>
  env: NodeJS.ProcessEnv
}

/** Electron's default userData root for the ZCode app, per platform. */
function zcodeAppData(env: NodeJS.ProcessEnv): string {
  const override = env['ZCODE_DATA_DIR']?.trim()
  if (override) return override
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), 'ZCode')
  if (process.platform !== 'darwin') return path.join(env['XDG_CONFIG_HOME'] ?? path.join(home, '.config'), 'ZCode')
  return path.join(home, 'Library', 'Application Support', 'ZCode')
}

function defaultDeps(): ZcodeDeps {
  return {
    fetch: globalThis.fetch,
    storageDir: path.join(zcodeAppData(process.env), 'session', 'Partitions', 'zcode-coding-plan', 'Local Storage', 'leveldb'),
    readDir: readdir,
    readJournal: async filePath => {
      try {
        const stats = await stat(filePath)
        if (!stats.isFile() || stats.size > MAX_JOURNAL_BYTES) return null
        return await readFile(filePath)
      } catch {
        return null
      }
    },
    env: process.env,
  }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'zcode', connection, primary: null, details: [], planLabel: null, footerLines }
}

/** Each Local Storage string carries a one-byte flag: 0x01 marks one-byte
 *  (Latin-1) characters, 0x00 marks UTF-16LE — recorded journals show the
 *  z.ai login stored the first way, other entries the other way, so the key is
 *  looked for in both encodings. */
const KEY_ENCODINGS: [Buffer, number][] = [[Buffer.from(STORAGE_KEY, 'latin1'), 0x01], [Buffer.from(STORAGE_KEY, 'utf16le'), 0x00]]
const TOKEN_PATTERN = /^[A-Za-z0-9_\-.=+/]{24,}$/
const UNREADABLE = 'the newest ZCode login entry could not be read'

/** A leveldb varint32: the value and the offset just past it. */
function varint(data: Buffer, at: number): [number, number] | null {
  let value = 0
  for (let i = 0; i < 5 && at + i < data.length; i++) {
    const byte = data[at + i]!
    value += (byte & 0x7f) * 2 ** (7 * i)
    if (byte < 0x80) return [value, at + i + 1]
  }
  return null
}

/** The tag (1 put, 0 delete) of the leveldb record whose key ends in the name
 *  at `at`, or null when those bytes are not a record key: the name can also
 *  sit inside some other entry's value. A record is the tag, a varint key
 *  length, then the key `_<origin>\0<flag><name>`. */
function recordTag(data: Buffer, at: number, name: Buffer, flag: number): number | null {
  if (data[at - 1] !== flag || data[at - 2] !== 0x00) return null
  const end = at + name.length
  for (let keyStart = at - 3; keyStart >= Math.max(2, at - 512); keyStart--) {
    if (data[keyStart] !== 0x5f) continue
    for (let n = 1; n <= 3 && keyStart - n >= 1; n++) {
      const length = varint(data, keyStart - n)
      const tag = data[keyStart - n - 1]
      if (length && length[1] === keyStart && length[0] === end - keyStart && (tag === 0x00 || tag === 0x01)) return tag
    }
  }
  return null
}

/** Only the last write of the key counts, matching how the journal replays; a
 *  delete or an empty value (`''`) means the app cleared the login. After the
 *  key comes the value's varint length, then the string flag and the string
 *  itself; the length, not the token alphabet, ends the token, because the next
 *  record's checksum can be token characters too. A last write that does not
 *  parse throws rather than falling back to an older, replaced token. */
function tokenAfterKey(data: Buffer): string | null {
  const hits: { at: number; name: Buffer; flag: number }[] = []
  for (const [name, flag] of KEY_ENCODINGS) {
    for (let at = data.indexOf(name); at !== -1; at = data.indexOf(name, at + 1)) hits.push({ at, name, flag })
  }
  hits.sort((a, b) => b.at - a.at)
  for (const { at, name, flag: keyFlag } of hits) {
    const tag = recordTag(data, at, name, keyFlag)
    if (tag === null) continue
    if (tag === 0x00) return ''
    const frame = varint(data, at + name.length)
    const [length, start] = frame ?? [0, 0]
    const flag = data[start]
    if (length < 1 || start + length > data.length || (flag !== 0x00 && flag !== 0x01)) throw new Error(UNREADABLE)
    const value = data.toString(flag === 0x01 ? 'latin1' : 'utf16le', start + 1, start + length)
    if (value !== '' && !TOKEN_PATTERN.test(value)) throw new Error(UNREADABLE)
    return value
  }
  return null
}

/** `null` when no journal holds the login — the same state as never signed in;
 *  `''` when the newest write cleared it. Throws when that write is unreadable. */
export async function zcodeAccessToken(deps: ZcodeDeps): Promise<string | null> {
  let names: string[]
  try { names = await deps.readDir(deps.storageDir) } catch { return null }
  // Journal names are zero-padded counters, so descending name order is
  // newest-first; once a journal is compacted into a .ldb its records move
  // there (snappy-compressed, invisible to this scan) and it is deleted.
  const journals = names.filter(name => name.endsWith('.log')).sort().reverse()
  for (const name of journals) {
    const data = await deps.readJournal(path.join(deps.storageDir, name))
    if (data === null) continue
    const token = tokenAfterKey(data)
    if (token !== null) return token
  }
  return null
}

export type ZcodeDecoded = QuotaProvider | 'rejected' | null

export function decodeZcodeUsage(body: unknown): ZcodeDecoded {
  return decodeZaiPlanUsage('zcode', body)
}

export type ZcodeResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchZcodeQuota(options: Partial<ZcodeDeps> & { signal?: AbortSignal } = {}): Promise<ZcodeResult> {
  const deps = { ...defaultDeps(), ...options }
  try {
    const token = await zcodeAccessToken(deps)
    if (token === null) return { quota: empty('disconnected') }
    if (token === '') return { quota: empty('terminalFailure', EXPIRED_FOOTER) }

    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal),
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'CodeBurn',
      },
    })
    // Only the ZCode app can mint a new login, so a rejected token is terminal.
    if (response.status === 401 || response.status === 403) return { quota: empty('terminalFailure', EXPIRED_FOOTER) }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return {
        quota: { ...empty('transientFailure', RATE_LIMITED_FOOTER), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60),
      }
    }
    if (response.status >= 500) return { quota: empty('transientFailure', UNAVAILABLE_FOOTER) }
    if (!response.ok) return { quota: empty('transientFailure', PARSE_FOOTER) }
    // Never log the body - it carries account data.
    const decoded = decodeZcodeUsage(await response.json())
    if (decoded === 'rejected') return { quota: empty('terminalFailure', EXPIRED_FOOTER) }
    return { quota: decoded ?? empty('transientFailure', PARSE_FOOTER) }
  } catch (error) {
    console.warn(`ZCode quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
