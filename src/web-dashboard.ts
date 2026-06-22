import { createServer } from 'http'
import { exec } from 'child_process'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, normalize, extname, dirname, sep } from 'path'
import { fileURLToPath } from 'url'
import { AddressInfo } from 'net'

import { hostname } from 'os'

import { loadPricing } from './models.js'
import { buildMenubarPayloadForRange } from './usage-aggregator.js'
import { periodInfoFromQuery, UsageQueryError } from './cli-date.js'
import { pullDevices, linkRemote } from './sharing/host.js'
import { browse } from './sharing/discovery.js'
import { loadOrCreateIdentity } from './sharing/identity.js'
import { pairingCode } from './sharing/pairing.js'
import { getSharingDir, loadRemotes, loadShareAlways, saveShareAlways } from './sharing/store.js'
import { ShareController } from './sharing/share-controller.js'
import { sanitizeForSharing } from './sharing/sanitize.js'

function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1_000_000) reject(new Error('request body too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function writeJsonError(res: import('http').ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error }))
}

const HERE = dirname(fileURLToPath(import.meta.url))

// Locate the built React dashboard (dist/dash). Works both when running from a
// published package (dist/dash next to the bundled CLI) and from source.
function resolveDashDir(): string | null {
  const candidates = [
    process.env['CODEBURN_DASH_DIR'],
    join(HERE, 'dash'),
    join(HERE, '..', 'dist', 'dash'),
    join(HERE, '..', 'dash', 'dist'),
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir
  }
  return null
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

const NOT_BUILT_PAGE =
  '<!doctype html><meta charset="utf-8">' +
  '<body style="font-family:system-ui;background:#0a0a0b;color:#e7e7ea;padding:48px;line-height:1.6">' +
  '<h2>Dashboard not built yet</h2>' +
  '<p>Build the web UI once, then reload:</p>' +
  '<pre style="background:#141417;padding:12px 16px;border-radius:8px;color:#ff8c42">cd dash &amp;&amp; npm install &amp;&amp; npm run build</pre>' +
  '<p>The CLI keeps serving the live data API in the meantime.</p></body>'

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'
  try {
    exec(`${cmd} ${url}`)
  } catch {
    /* user can open it manually */
  }
}

export async function runWebDashboard(opts: {
  period: string
  provider: string
  from?: string
  to?: string
  project: string[]
  exclude: string[]
  port: number
  open: boolean
}): Promise<void> {
  await loadPricing()
  const dashDir = resolveDashDir()

  // Sharing this device serves the SANITIZED aggregate (no project names/paths
  // or per-session detail), unlike the local /api/usage which shows everything.
  const shareGetUsage = async (q: { period?: string; from?: string; to?: string }) => {
    const periodInfo = periodInfoFromQuery(q, opts.period)
    return sanitizeForSharing(await buildMenubarPayloadForRange(periodInfo, { provider: 'all', optimize: false }))
  }
  const share = new ShareController(shareGetUsage)
  if (await loadShareAlways()) await share.start(true).catch(() => {})

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')

      // Loopback-only server. Reject any request not addressed to localhost
      // (defeats DNS rebinding, which would otherwise let a website you visit
      // read your local usage) and any cross-origin request (CSRF). The local
      // payload is unsanitized, so this guard is what keeps it on your machine.
      const reqHost = (req.headers.host ?? '').replace(/:\d+$/, '')
      const loopback = reqHost === '127.0.0.1' || reqHost === 'localhost' || reqHost === '::1' || reqHost === '[::1]'
      const origin = req.headers.origin
      const originOk = !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)
      if (!loopback || !originOk) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      if (url.pathname === '/api/usage') {
        const period = url.searchParams.get('period') ?? opts.period
        const provider = url.searchParams.get('provider') ?? opts.provider
        const from = url.searchParams.get('from') ?? opts.from
        const to = url.searchParams.get('to') ?? opts.to
        let periodInfo
        try {
          periodInfo = periodInfoFromQuery({ period, from, to }, opts.period)
        } catch (err) {
          if (!(err instanceof UsageQueryError)) throw err
          writeJsonError(res, 400, err instanceof Error ? err.message : String(err))
          return
        }
        const payload = await buildMenubarPayloadForRange(periodInfo, {
          provider,
          project: opts.project,
          exclude: opts.exclude,
          optimize: false,
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
        return
      }

      // This machine plus every paired device, each kept separate. Remote
      // payloads arrive already sanitized (aggregate numbers only).
      if (url.pathname === '/api/devices') {
        const period = url.searchParams.get('period') ?? opts.period
        const provider = url.searchParams.get('provider') ?? opts.provider
        const from = url.searchParams.get('from') ?? opts.from
        const to = url.searchParams.get('to') ?? opts.to
        try {
          periodInfoFromQuery({ period, from, to }, opts.period)
        } catch (err) {
          if (!(err instanceof UsageQueryError)) throw err
          writeJsonError(res, 400, err instanceof Error ? err.message : String(err))
          return
        }
        const localGetUsage = async (q: { period?: string; from?: string; to?: string }) => {
          const periodInfo = periodInfoFromQuery(q, period)
          return buildMenubarPayloadForRange(periodInfo, { provider, project: opts.project, exclude: opts.exclude, optimize: false })
        }
        const results = await pullDevices(localGetUsage, { period, from, to }, hostname(), {})
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ devices: results }))
        return
      }

      // This device's own identity (name + fingerprint) for the pairing UI.
      if (url.pathname === '/api/identity') {
        const id = await loadOrCreateIdentity(getSharingDir())
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ name: id.name, fingerprint: id.fingerprint }))
        return
      }

      // Discover devices currently sharing on the local network (mDNS). Each
      // carries the confirm code to match, and whether it is already paired.
      if (url.pathname === '/api/devices/scan') {
        const dir = getSharingDir()
        const id = await loadOrCreateIdentity(dir)
        const pairedFps = new Set((await loadRemotes(dir)).map((r) => r.fingerprint))
        const found = await browse(2500)
        const list = found
          .filter((d) => d.fingerprint !== id.fingerprint)
          .map((d) => ({
            name: d.name,
            host: d.host,
            port: d.port,
            fingerprint: d.fingerprint,
            code: pairingCode(id.fingerprint, d.fingerprint),
            paired: pairedFps.has(d.fingerprint),
          }))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ found: list }))
        return
      }

      // Pair with a chosen discovered device. Blocks until the other device
      // approves (or declines / times out), then stores the link.
      if (url.pathname === '/api/devices/pair' && req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').includes('application/json')) {
          res.writeHead(415, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'content-type must be application/json' }))
          return
        }
        const body = JSON.parse((await readBody(req)) || '{}') as { name: string; host: string; port: number; fingerprint: string }
        try {
          const device = await linkRemote(body)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, name: device.name }))
        } catch (err) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Share-this-device controls. Status carries the pending pairing requests
      // so the SPA can poll one endpoint and surface approvals in the browser.
      if (url.pathname === '/api/share/status') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(await share.status()))
        return
      }
      if (url.pathname === '/api/share/start' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { always?: boolean }
        let startError: string | undefined
        try {
          await share.start(!!body.always)
          await saveShareAlways(!!body.always)
        } catch (err) {
          // e.g. EADDRINUSE when a CLI `codeburn share` already holds the port.
          startError = err instanceof Error ? err.message : String(err)
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ...(await share.status()), error: startError }))
        return
      }
      if (url.pathname === '/api/share/stop' && req.method === 'POST') {
        await share.stop()
        await saveShareAlways(false)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(await share.status()))
        return
      }
      if (url.pathname === '/api/share/approve' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { id?: string; approve?: boolean }
        const ok = typeof body.id === 'string' && share.resolvePending(body.id, !!body.approve)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok }))
        return
      }

      if (!dashDir) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(NOT_BUILT_PAGE)
        return
      }

      let pathname = decodeURIComponent(url.pathname)
      if (pathname === '/' || pathname === '') pathname = '/index.html'
      const filePath = normalize(join(dashDir, pathname))
      if (filePath !== dashDir && !filePath.startsWith(dashDir + sep)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      try {
        const buf = await readFile(filePath)
        res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' })
        res.end(buf)
      } catch {
        // Unknown path: serve index.html so the SPA can route it.
        const buf = await readFile(join(dashDir, 'index.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(buf)
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      } else {
        reject(err)
      }
    })
    server.listen(opts.port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
  // Durable handler so a post-bind socket error never crashes the process.
  server.on('error', () => {})

  const url = `http://127.0.0.1:${port}`
  if (!dashDir) {
    process.stdout.write(`\n  Dashboard UI is not built. Run: cd dash && npm install && npm run build\n`)
  }
  process.stdout.write(`\n  CodeBurn dashboard at ${url}\n  Press Ctrl+C to stop.\n\n`)
  if (opts.open) openBrowser(url)

  // Withdraw the mDNS advertisement and close the share server cleanly on exit.
  process.on('SIGINT', () => {
    void share.stop().finally(() => process.exit(0))
  })

  await new Promise<never>(() => {
    /* run until interrupted */
  })
}
