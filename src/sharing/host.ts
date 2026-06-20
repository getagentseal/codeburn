import { hello, pair, pairRequest, fetchUsage } from './client.js'
import { loadOrCreateIdentity } from './identity.js'
import { pairingCode } from './pairing.js'
import { sanitizeForSharing } from './sanitize.js'
import type { DiscoveredDevice } from './discovery.js'
import type { UsageQuery } from './share-server.js'
import { getSharingDir, loadRemotes, saveRemotes, type RemoteDevice } from './store.js'
import type { MenubarPayload } from '../menubar-json.js'
import { formatCost } from '../currency.js'
import { renderTable } from '../text-table.js'
import { Chalk } from 'chalk'

// Minimal shape we read from a device's usage payload (the menubar payload).
// Cache create/read are only in the daily history, so we sum those.
type DevicePayload = {
  current?: { cost?: number; calls?: number; sessions?: number; inputTokens?: number; outputTokens?: number }
  history?: { daily?: Array<{ cacheReadTokens?: number; cacheWriteTokens?: number }> }
}

export type DeviceUsage = {
  id: string // stable unique id (cert fingerprint for remotes, 'local' for this device)
  name: string
  local: boolean
  payload?: DevicePayload
  error?: string
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
  const num = (n: number | undefined): number => n ?? 0
  const n = (x: number): string => Math.round(x).toLocaleString()
  const money = (x: number): string => formatCost(x).replace(/(\d)(?=(\d{3})+(\.|$))/g, '$1,')
  const rows = results.map((d) => {
    const cur = d.payload?.current
    const daily = d.payload?.history?.daily ?? []
    const input = num(cur?.inputTokens)
    const output = num(cur?.outputTokens)
    const cacheCreate = daily.reduce((s, e) => s + num(e.cacheWriteTokens), 0)
    const cacheRead = daily.reduce((s, e) => s + num(e.cacheReadTokens), 0)
    return {
      name: d.name + (d.local ? ' (this Mac)' : ''),
      error: d.error,
      cost: num(cur?.cost),
      input,
      output,
      cacheCreate,
      cacheRead,
      total: input + output + cacheCreate + cacheRead,
    }
  })
  const combined = rows.reduce(
    (a, r) => ({
      cost: a.cost + r.cost,
      input: a.input + r.input,
      output: a.output + r.output,
      cacheCreate: a.cacheCreate + r.cacheCreate,
      cacheRead: a.cacheRead + r.cacheRead,
      total: a.total + r.total,
    }),
    { cost: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
  )

  const tableRows = [
    ...rows.map((r) =>
      r.error
        ? [r.name, r.error, '-', '-', '-', '-', '-']
        : [r.name, money(r.cost), n(r.total), n(r.input), n(r.output), n(r.cacheCreate), n(r.cacheRead)],
    ),
    ['Combined', money(combined.cost), n(combined.total), n(combined.input), n(combined.output), n(combined.cacheCreate), n(combined.cacheRead)],
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
