// The Devin quota reader against synthetic caches: every payload is built here
// with a small protobuf encoder, never copied from a real UserStatus.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { decodeDevinStatus, fetchDevinQuota } from '../src/quota/devin.js'

function varint(value: bigint): number[] {
  let v = BigInt.asUintN(64, value)
  const out: number[] = []
  do {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    out.push(v > 0n ? byte | 0x80 : byte)
  } while (v > 0n)
  return out
}
const num = (field: number, value: number | bigint) => [...varint(BigInt(field << 3)), ...varint(BigInt(value))]
const msg = (field: number, body: number[]) => [...varint(BigInt((field << 3) | 2)), ...varint(BigInt(body.length)), ...body]
const str = (field: number, text: string) => msg(field, [...Buffer.from(text)])

const FETCHED = 1_790_622_000
const DAILY_RESET = 1_790_668_800
const WEEKLY_RESET = 1_791_100_800
const NOW = (FETCHED + 3 * 3600) * 1000

function status(fields: { daily?: number; weekly?: number; dailyReset?: number; weeklyReset?: number; plan?: string } = {}): Uint8Array {
  const { daily = 100, weekly = 96, dailyReset = DAILY_RESET, weeklyReset = WEEKLY_RESET, plan = 'Pro' } = fields
  const planStatus = [
    ...msg(1, [...num(1, 16), ...str(2, plan), ...str(33, 'synthetic org block')]),
    ...num(8, -1),
    ...(fields.daily === undefined && 'daily' in fields ? [] : num(14, daily)),
    ...num(15, weekly),
    ...(dailyReset ? num(17, dailyReset) : []),
    ...num(18, weeklyReset),
  ]
  return Uint8Array.from([...num(1, 7), ...str(5, 'synthetic@example.invalid'), ...msg(13, planStatus), ...str(33, 'x')])
}

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  dirs = []
})

async function cacheDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codeburn-devin-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 })
  }
  return dir
}

const envelope = (payload: Uint8Array, fetchedAt = FETCHED, version = 1) =>
  ({ version, identity_digest: 'synthetic', fetched_at_secs: fetchedAt, payload: Buffer.from(payload).toString('base64') })

describe('Devin quota decoding', () => {
  it('reads plan, daily and weekly windows as used percent', () => {
    const quota = decodeDevinStatus(status(), FETCHED, NOW)
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Pro')
    expect(quota.details).toEqual([
      { label: 'Daily', percent: 0, resetsAt: '2026-09-29T08:00:00.000Z' },
      { label: 'Weekly', percent: 0.04, resetsAt: '2026-10-04T08:00:00.000Z' },
    ])
    expect(quota.primary?.label).toBe('Weekly')
    expect(quota.footerLines).toEqual(['Updated 3h ago, refreshes while the Devin CLI runs.'])
  })

  it('treats -1 as unlimited: no bar, a note instead', () => {
    const quota = decodeDevinStatus(status({ daily: -1 }), FETCHED, NOW)
    expect(quota.connection).toBe('connected')
    expect(quota.details.map(row => row.label)).toEqual(['Weekly'])
    expect(quota.notes).toEqual(['Daily: unlimited'])
  })

  it('reads an absent percent next to a reset as exhausted (proto3 omits zero)', () => {
    const quota = decodeDevinStatus(status({ daily: undefined }), FETCHED, NOW)
    expect(quota.details[0]).toMatchObject({ label: 'Daily', percent: 1 })
  })

  it('refuses out-of-range percents and implausible resets instead of showing them', () => {
    for (const bad of [status({ weekly: 101 }), status({ daily: -2 }), status({ weeklyReset: FETCHED - 10 }), status({ dailyReset: 4_000_000_000 })]) {
      const quota = decodeDevinStatus(bad, FETCHED, NOW)
      expect(quota.connection).toBe('terminalFailure')
      expect(quota.details).toEqual([])
    }
    expect(decodeDevinStatus(Uint8Array.from([0x6a, 0x7f, 0x01]), FETCHED, NOW).connection).toBe('terminalFailure')
  })

  it('drops a window whose reset has passed since the fetch', () => {
    const afterDaily = (DAILY_RESET + 60) * 1000
    expect(decodeDevinStatus(status(), FETCHED, afterDaily).details.map(row => row.label)).toEqual(['Weekly'])
    const quota = decodeDevinStatus(status(), FETCHED, (WEEKLY_RESET + 60) * 1000)
    expect(quota.connection).toBe('transientFailure')
    expect(quota.details).toEqual([])
  })
})

describe('Devin cache discovery', () => {
  it('is disconnected with no cache directory', async () => {
    const quota = (await fetchDevinQuota({ cacheDir: path.join(os.tmpdir(), 'codeburn-devin-missing-dir'), now: () => NOW })).quota
    expect(quota.connection).toBe('disconnected')
  })

  it('takes the newest identity by fetched_at_secs', async () => {
    const dir = await cacheDir({
      'user_status.aaaa.bin': envelope(status({ plan: 'Old' }), FETCHED - 100),
      'user_status.bbbb.bin': envelope(status({ plan: 'Pro' }), FETCHED),
      'unrelated.bin': 'not json',
    })
    const quota = (await fetchDevinQuota({ cacheDir: dir, now: () => NOW })).quota
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Pro')
  })

  it('refuses an unknown envelope version', async () => {
    const dir = await cacheDir({ 'user_status.aaaa.bin': envelope(status(), FETCHED, 2) })
    expect((await fetchDevinQuota({ cacheDir: dir, now: () => NOW })).quota.connection).toBe('terminalFailure')
  })
})
