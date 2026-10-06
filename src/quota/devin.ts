// Devin plan quota, read only from the cache the Devin CLI keeps of its last
// UserStatus response: ~/.cache/devin/cli/user_status.<identity digest>.bin, a
// JSON envelope {version, identity_digest, fetched_at_secs, payload} whose
// payload is a base64 protobuf. No network call and no API key: the numbers
// are as fresh as the CLI's last run, and every reading says how old it is.
//
// The payload also carries the account's email and name. Only the plan status
// message (field 13) is walked, and only the fields below are read from it:
//   13.1.2 plan name, 13.14 / 13.15 daily / weekly quota remaining percent
//   (-1 = unlimited), 13.17 / 13.18 daily / weekly reset (unix seconds).
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { compactAge } from './codex.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const NO_CACHE_FOOTER = ['Run the Devin CLI once to sign in.']
const MALFORMED_FOOTER = ["Devin's cached plan status was not in the expected format."]
const OUT_OF_DATE_FOOTER = ["Devin's cached quota is from before the last reset; run the Devin CLI to refresh it."]
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const MAX_RESET_AHEAD_SECS = 400 * 86_400
const MAX_CLOCK_SKEW_SECS = 300

const WINDOWS = [
  { label: 'Daily', remainingField: 14, resetField: 17 },
  { label: 'Weekly', remainingField: 15, resetField: 18 },
] as const

export type DevinDeps = { cacheDir: string; now: () => number }

function defaultDeps(): DevinDeps {
  return { cacheDir: path.join(os.homedir(), '.cache', 'devin', 'cli'), now: Date.now }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'devin', connection, primary: null, details: [], planLabel: null, footerLines }
}

type Field = { wire: number; value?: bigint; bytes?: Uint8Array }

function readVarint(buf: Uint8Array, pos: number): [bigint, number] | null {
  let result = 0n
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) return null
    const byte = buf[pos++]!
    result |= BigInt(byte & 0x7f) << BigInt(7 * i)
    if ((byte & 0x80) === 0) return [BigInt.asIntN(64, result), pos]
  }
  return null
}

/** One protobuf message level, last occurrence wins. `null` on anything that is
 *  not a well-formed message: a truncated varint, a length past the end, a
 *  group wire type or field number 0. */
function parseMessage(buf: Uint8Array): Map<number, Field> | null {
  const fields = new Map<number, Field>()
  let pos = 0
  while (pos < buf.length) {
    const key = readVarint(buf, pos)
    if (!key || key[0] < 8n) return null
    pos = key[1]
    const field = Number(key[0] >> 3n)
    const wire = Number(key[0] & 7n)
    if (wire === 0) {
      const value = readVarint(buf, pos)
      if (!value) return null
      fields.set(field, { wire, value: value[0] })
      pos = value[1]
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      if (!len || len[0] < 0n || BigInt(len[1]) + len[0] > BigInt(buf.length)) return null
      const end = len[1] + Number(len[0])
      fields.set(field, { wire, bytes: buf.subarray(len[1], end) })
      pos = end
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4
      if (pos > buf.length) return null
      fields.set(field, { wire })
    } else {
      return null
    }
  }
  return fields
}

function planName(status: Map<number, Field>): string | null | undefined {
  const plan = status.get(1)
  if (plan === undefined) return null
  if (plan.wire !== 2) return undefined
  const info = parseMessage(plan.bytes!)
  if (!info) return undefined
  const name = info.get(2)
  if (name === undefined) return null
  if (name.wire !== 2) return undefined
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(name.bytes!).trim()
  } catch {
    return undefined
  }
  return text.length > 0 && text.length <= 64 ? text : null
}

/**
 * The quota a cached UserStatus payload describes. Any field that is present
 * but not what the schema promises — a percent outside 0..100, a reset that is
 * not a plausible time after the fetch — fails the whole reading rather than
 * showing a number that may be wrong.
 *
 * A percent that is absent while its reset is present reads as 0 remaining:
 * proto3 does not write a zero scalar, so that is how an exhausted window
 * arrives on the wire.
 */
export function decodeDevinStatus(payload: Uint8Array, fetchedAtSecs: number, nowMs: number): QuotaProvider {
  const malformed = empty('terminalFailure', MALFORMED_FOOTER)
  const top = parseMessage(payload)
  const statusField = top?.get(13)
  if (!statusField || statusField.wire !== 2) return malformed
  const status = parseMessage(statusField.bytes!)
  if (!status) return malformed
  const plan = planName(status)
  if (plan === undefined) return malformed

  const details: QuotaWindow[] = []
  const notes: string[] = []
  let outOfDate = false
  for (const window of WINDOWS) {
    const remaining = status.get(window.remainingField)
    const reset = status.get(window.resetField)
    if (remaining && remaining.wire !== 0) return malformed
    if (remaining?.value === -1n) {
      notes.push(`${window.label}: unlimited`)
      continue
    }
    if (reset === undefined) {
      if (remaining === undefined) continue
      return malformed
    }
    if (reset.wire !== 0) return malformed
    const left = remaining?.value ?? 0n
    if (left < 0n || left > 100n) return malformed
    const resetSecs = Number(reset.value!)
    if (resetSecs <= fetchedAtSecs || resetSecs > fetchedAtSecs + MAX_RESET_AHEAD_SECS) return malformed
    if (resetSecs * 1000 <= nowMs) {
      outOfDate = true
      continue
    }
    details.push({
      label: window.label,
      percent: (100 - Number(left)) / 100,
      resetsAt: new Date(resetSecs * 1000).toISOString(),
    })
  }

  if (details.length === 0 && notes.length === 0) {
    return outOfDate ? empty('transientFailure', OUT_OF_DATE_FOOTER) : malformed
  }
  return {
    provider: 'devin',
    connection: 'connected',
    primary: details.find(row => row.label === 'Weekly') ?? details[0] ?? null,
    details,
    planLabel: plan,
    footerLines: [`Updated ${compactAge(fetchedAtSecs * 1000, nowMs)}, refreshes while the Devin CLI runs.`],
    ...(notes.length > 0 ? { notes } : {}),
  }
}

type Envelope = { version: unknown; fetchedAtSecs: number; payload: unknown }

async function readEnvelope(file: string): Promise<Envelope | null> {
  try {
    if ((await stat(file)).size > MAX_CACHE_BYTES) return null
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const fetchedAtSecs = raw['fetched_at_secs']
    if (typeof fetchedAtSecs !== 'number' || !Number.isInteger(fetchedAtSecs) || fetchedAtSecs <= 0) return null
    return { version: raw['version'], fetchedAtSecs, payload: raw['payload'] }
  } catch {
    return null
  }
}

export async function fetchDevinQuota(options: Partial<DevinDeps> = {}): Promise<{ quota: QuotaProvider }> {
  const deps = { ...defaultDeps(), ...options }
  let names: string[]
  try {
    names = (await readdir(deps.cacheDir)).filter(name => /^user_status\..+\.bin$/.test(name))
  } catch {
    names = []
  }
  if (names.length === 0) return { quota: empty('disconnected', NO_CACHE_FOOTER) }

  // One file per signed-in identity; the newest fetch is the account in use.
  let newest: Envelope | null = null
  for (const name of names) {
    const envelope = await readEnvelope(path.join(deps.cacheDir, name))
    if (envelope && (!newest || envelope.fetchedAtSecs > newest.fetchedAtSecs)) newest = envelope
  }
  if (!newest) return { quota: empty('terminalFailure', MALFORMED_FOOTER) }
  if (newest.version !== 1) {
    return { quota: empty('terminalFailure', ["Devin's quota cache is in a newer format CodeBurn cannot read yet."]) }
  }
  const nowMs = deps.now()
  if (typeof newest.payload !== 'string' || newest.fetchedAtSecs * 1000 > nowMs + MAX_CLOCK_SKEW_SECS * 1000) {
    return { quota: empty('terminalFailure', MALFORMED_FOOTER) }
  }
  return { quota: decodeDevinStatus(Buffer.from(newest.payload, 'base64'), newest.fetchedAtSecs, nowMs) }
}
