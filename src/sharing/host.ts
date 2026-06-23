import { hello, pair, pairRequest, fetchUsage } from './client.js'
import { loadOrCreateIdentity } from './identity.js'
import { pairingCode } from './pairing.js'
import { sanitizeForSharing } from './sanitize.js'
import type { DiscoveredDevice } from './discovery.js'
import type { UsageQuery } from './share-server.js'
import { getSharingDir, loadRemotes, saveRemotes, type RemoteDevice } from './store.js'
import type { CombinedUsage, DeviceSummary, MenubarPayload } from '../menubar-json.js'
import { formatCost } from '../currency.js'
import { renderTable } from '../text-table.js'
import { Chalk } from 'chalk'

export type { CombinedUsage, DeviceSummary } from '../menubar-json.js'

// Minimal shape we read from a device's usage payload (the menubar payload).
// Cache create/read are only in the daily history, so we sum those.
type DevicePayload = {
  current?: { cost?: number; calls?: number; sessions?: number; inputTokens?: number; outputTokens?: number }
  history?: { daily?: Array<{ date?: string; cacheReadTokens?: number; cacheWriteTokens?: number }> }
}

type SummaryWindow = {
  start: string
  end: string
}

export type DeviceUsage = {
  id: string // stable unique id (cert fingerprint for remotes, 'local' for this device)
  name: string
  local: boolean
  payload?: DevicePayload
  error?: string
}

const zeroUsage = {
  cost: 0,
  calls: 0,
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
}

function num(n: number | undefined): number {
  return n ?? 0
}

function summarizeOneDevice(d: DeviceUsage, window?: SummaryWindow): DeviceSummary {
  const error = d.error !== undefined ? d.error : d.payload === undefined ? 'no usage payload' : undefined
  if (error !== undefined || d.payload === undefined) {
    return {
      id: d.id,
      name: d.name,
      local: d.local,
      error,
      ...zeroUsage,
    }
  }

  const cur = d.payload.current
  const daily = (d.payload.history?.daily ?? []).filter((e) => {
    if (window === undefined) return true
    return e.date !== undefined && window.start <= e.date && e.date <= window.end
  })
  const inputTokens = num(cur?.inputTokens)
  const outputTokens = num(cur?.outputTokens)
  const cacheCreateTokens = daily.reduce((s, e) => s + num(e.cacheWriteTokens), 0)
  const cacheReadTokens = daily.reduce((s, e) => s + num(e.cacheReadTokens), 0)
  return {
    id: d.id,
    name: d.name,
    local: d.local,
    cost: num(cur?.cost),
    calls: num(cur?.calls),
    sessions: num(cur?.sessions),
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens,
  }
}

export function summarizeDeviceUsage(results: DeviceUsage[], window?: SummaryWindow): CombinedUsage {
  const perDevice = results.map((d) => summarizeOneDevice(d, window))
  const combined = perDevice.reduce(
    (a, d) => {
      if (d.error !== undefined) return a
      return {
        cost: a.cost + d.cost,
        calls: a.calls + d.calls,
        sessions: a.sessions + d.sessions,
        inputTokens: a.inputTokens + d.inputTokens,
        outputTokens: a.outputTokens + d.outputTokens,
        cacheCreateTokens: a.cacheCreateTokens + d.cacheCreateTokens,
        cacheReadTokens: a.cacheReadTokens + d.cacheReadTokens,
        totalTokens: a.totalTokens + d.totalTokens,
        deviceCount: a.deviceCount,
        reachableCount: a.reachableCount + 1,
      }
    },
    { ...zeroUsage, deviceCount: perDevice.length, reachableCount: 0 },
  )
  return { perDevice, combined }
}

function parseHostPort(input: string, defaultPort: number): { host: string; port: number } {
  const idx = input.lastIndexOf(':')
  if (idx > 0 && /^\d+$/.test(input.slice(idx + 1))) {
    return { host: input.slice(0, idx), port: Number(input.slice(idx + 1)) }
  }
  return { host: input, port: defaultPort }
}

// Pair with a device the user is currently sharing (PIN shown on that device),
// pin its fingerprint, store the issued token, and persist it.
export async function addRemote(
  input: string,
  pin: string,
  opts: { defaultPort: number; dir?: string },
): Promise<RemoteDevice> {
  const dir = opts.dir ?? getSharingDir()
  const identity = await loadOrCreateIdentity(dir)
  const { host, port } = parseHostPort(input, opts.defaultPort)

  const h = await hello({ identity, host, port })
  if (h.status !== 200) throw new Error(`could not reach a CodeBurn device at ${host}:${port}`)
  const info = h.json as { fingerprint: string; name: string }

  const pr = await pair({ identity, host, port, expectedFingerprint: info.fingerprint }, pin, identity.name)
  if (pr.status !== 200) {
    const err = (pr.json as { error?: string })?.error ?? `HTTP ${pr.status}`
    throw new Error(`pairing failed: ${err}`)
  }
  const token = (pr.json as { token: string }).token

  const device: RemoteDevice = { name: info.name, host, port, fingerprint: info.fingerprint, token, addedAt: Date.now() }
  const remotes = (await loadRemotes(dir)).filter((r) => r.fingerprint !== device.fingerprint)
  remotes.push(device)
  await saveRemotes(remotes, dir)
  return device
}

// Pair with a discovered device using approve-style pairing (no PIN). The owner
// of that device approves on their screen after confirming the matching code.
export async function linkRemote(
  d: DiscoveredDevice,
  opts: { dir?: string; onCode?: (code: string) => void } = {},
): Promise<RemoteDevice> {
  const dir = opts.dir ?? getSharingDir()
  const identity = await loadOrCreateIdentity(dir)
  const code = pairingCode(identity.fingerprint, d.fingerprint)
  opts.onCode?.(code)
  const r = await pairRequest({ identity, host: d.host, port: d.port, expectedFingerprint: d.fingerprint }, identity.name)
  if (r.status !== 200) {
    throw new Error(r.status === 403 ? 'the other device declined' : `pairing failed (HTTP ${r.status})`)
  }
  const token = (r.json as { token: string }).token
  const device: RemoteDevice = { name: d.name, host: d.host, port: d.port, fingerprint: d.fingerprint, token, addedAt: Date.now() }
  const remotes = (await loadRemotes(dir)).filter((x) => x.fingerprint !== device.fingerprint)
  remotes.push(device)
  await saveRemotes(remotes, dir)
  return device
}

// Pull this machine's usage plus every paired remote's, each kept separate.
export async function pullDevices(
  localGetUsage: (q: UsageQuery) => Promise<DevicePayload>,
  query: UsageQuery,
  localName: string,
  opts: { dir?: string } = {},
): Promise<DeviceUsage[]> {
  const dir = opts.dir ?? getSharingDir()
  const identity = await loadOrCreateIdentity(dir)
  const remotes = await loadRemotes(dir)

  const local: DeviceUsage = { id: 'local', name: localName, local: true, payload: await localGetUsage(query) }
  // Pull every remote concurrently and isolate failures, so one slow or
  // powered-off device degrades to an error row instead of blocking the rest.
  const remoteResults = await Promise.all(
    remotes.map(async (r): Promise<DeviceUsage> => {
      try {
        const res = await fetchUsage({ identity, host: r.host, port: r.port, expectedFingerprint: r.fingerprint }, r.token, query)
        // Re-sanitize on receipt: do not trust the sender to have stripped its
        // own project names/sessions (it may run an older build). Belt and
        // suspenders alongside the sender-side sanitize.
        if (res.status === 200) return { id: r.fingerprint, name: r.name, local: false, payload: sanitizeForSharing(res.json as MenubarPayload) }
        return { id: r.fingerprint, name: r.name, local: false, error: res.status === 401 ? 'not authorized (re-pair?)' : `HTTP ${res.status}` }
      } catch (e) {
        return { id: r.fingerprint, name: r.name, local: false, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
  return [local, ...remoteResults]
}

// Joined "Totals by machine" report: one row per device plus a bold Combined
// row. Tokens are shown as full, comma-grouped numbers.
export function renderDevices(results: DeviceUsage[]): string {
  const n = (x: number): string => Math.round(x).toLocaleString()
  const money = (x: number): string => formatCost(x).replace(/(\d)(?=(\d{3})+(\.|$))/g, '$1,')
  const summary = summarizeDeviceUsage(results)
  const rows = summary.perDevice.map((d) => ({
    name: d.name + (d.local ? ' (this Mac)' : ''),
    error: d.error,
    cost: d.cost,
    input: d.inputTokens,
    output: d.outputTokens,
    cacheCreate: d.cacheCreateTokens,
    cacheRead: d.cacheReadTokens,
    total: d.totalTokens,
  }))
  const combined = summary.combined

  const tableRows = [
    ...rows.map((r) =>
      r.error
        ? [r.name, r.error, '-', '-', '-', '-', '-']
        : [r.name, money(r.cost), n(r.total), n(r.input), n(r.output), n(r.cacheCreate), n(r.cacheRead)],
    ),
    ['Combined', money(combined.cost), n(combined.totalTokens), n(combined.inputTokens), n(combined.outputTokens), n(combined.cacheCreateTokens), n(combined.cacheReadTokens)],
  ]
  const table = renderTable(
    [
      { header: 'Host' },
      { header: 'Cost', right: true },
      { header: 'Total tokens', right: true },
      { header: 'Input', right: true },
      { header: 'Output', right: true },
      { header: 'Cache create', right: true },
      { header: 'Cache read', right: true },
    ],
    tableRows,
    { boldRows: new Set([tableRows.length - 1]) },
  )
  const heading = new Chalk({}).cyan('Totals by machine')
  return heading + '\n' + table + '\n'
}
