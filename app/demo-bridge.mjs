// DEMO HARNESS — NOT SHIPPED. Serves the Electron renderer's bridge calls over
// HTTP so the desktop app runs in a plain browser tab for demo recording.
// Read-only: every mutation channel is answered with a benign no-op.
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'dist', 'cli.js')

// ── resident serve child for the hot panel queries ──
const serve = spawn('node', [CLI, 'serve', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const waiters = new Map()
let nextId = 1
serve.stdout.setEncoding('utf8')
serve.stdout.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m) }
  }
})
const serveCall = (args) => new Promise((resolve, reject) => {
  const id = nextId++
  waiters.set(id, (m) => m.ok ? resolve(JSON.parse(m.output)) : reject(new Error(m.error)))
  serve.stdin.write(JSON.stringify({ id, args }) + '\n')
})
const execCall = (args) => new Promise((resolve, reject) => {
  execFile('node', [CLI, ...args], { maxBuffer: 1 << 28 }, (err, stdout) => {
    if (err) return reject(err)
    try { resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
  })
})

const range = (r) => r ? ['--from', r.from, '--to', r.to] : []
const prov = (p) => p && p !== 'all' ? ['--provider', p] : ['--provider', 'all']

// channel → argv, mirroring app/electron/main.ts builders
const ROUTES = {
  getOverview: (period, provider, r) => ['status', '--format', 'menubar-json', '--period', period, '--no-timeline', ...prov(provider), ...range(r)],
  getTimeline: (period, provider, r) => ['status', '--format', 'menubar-json', '--period', period, ...prov(provider), ...range(r)],
  getPlans: (period) => ['status', '--format', 'json', '--period', period],
  getModels: (period, provider, byTask, r) => ['models', '--format', 'json', '--period', period, ...prov(provider), ...(byTask ? ['--by-task'] : []), ...range(r)],
  getSessions: (period, provider, r) => ['sessions', '--format', 'json', '--period', period, ...prov(provider), ...range(r)],
  getSessionsContributions: (period, provider, r) => ['sessions', '--format', 'json', '--contributions', '--period', period, ...prov(provider), ...range(r)],
  getCompareModels: (period, provider) => ['compare', '--format', 'json', '--period', period, ...prov(provider)],
  getCompare: (period, provider, a, b) => ['compare', '--format', 'json', '--period', period, ...prov(provider), '--model-a', a, '--model-b', b],
  getYield: (period, provider, r) => ['yield', '--format', 'json', '--period', period, ...prov(provider), ...range(r)],
  getSpendFlow: (period, provider, r) => ['spend', '--format', 'flow-json', '--period', period, ...prov(provider), ...range(r)],
  getOptimizeReport: (period, provider, r) => ['optimize', '--format', 'json', '--period', period, ...prov(provider), ...range(r)],
  getAudit: (period, provider, r) => ['audit', '--format', 'json', '--period', period, ...prov(provider), ...range(r)],
  getActReport: () => ['act', 'report', '--json'],
  getShareStatus: () => ['share', 'status', '--format', 'json'],
  getIdentity: () => ['identity', '--format', 'json'],
  getAliases: () => ['model-alias', '--list', '--format', 'json'],
  getProxyPaths: () => ['proxy-path', '--list', '--format', 'json'],
  getPriceOverrides: () => ['price-override', '--list', '--format', 'json'],
  getDevices: (period) => ['devices', '--format', 'json', '--period', period],
}
const SERVED = new Set(['getOverview', 'getTimeline', 'getPlans', 'getModels', 'getSessions', 'getSessionsContributions', 'getCompareModels', 'getCompare', 'getYield', 'getSpendFlow', 'getOptimizeReport', 'getAudit'])

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') { res.end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    try {
      const { channel, args } = JSON.parse(body || '{}')
      const build = ROUTES[channel]
      if (!build) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); return }
      const argv = build(...(args ?? []))
      const value = SERVED.has(channel) ? await serveCall(argv) : await execCall(argv)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err?.message ?? err) }))
    }
  })
}).listen(4900, '127.0.0.1', () => console.log('demo bridge on http://127.0.0.1:4900'))
