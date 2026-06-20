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
import { getDateRange, parseDateRangeFlags, formatDateRangeLabel, toPeriod } from './cli-date.js'
import { pullDevices } from './sharing/host.js'

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

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (url.pathname === '/api/usage') {
        const period = url.searchParams.get('period') ?? opts.period
        const provider = url.searchParams.get('provider') ?? opts.provider
        const from = url.searchParams.get('from') ?? opts.from
        const to = url.searchParams.get('to') ?? opts.to
        const customRange = parseDateRangeFlags(from, to)
        const periodInfo = customRange
          ? { range: customRange, label: formatDateRangeLabel(from, to) }
          : getDateRange(toPeriod(period))
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
        const localGetUsage = async (q: { period?: string; from?: string; to?: string }) => {
          const customRange = parseDateRangeFlags(q.from, q.to)
          const periodInfo = customRange
            ? { range: customRange, label: formatDateRangeLabel(q.from, q.to) }
            : getDateRange(toPeriod(q.period ?? period))
          return buildMenubarPayloadForRange(periodInfo, { provider, project: opts.project, exclude: opts.exclude, optimize: false })
        }
        const results = await pullDevices(localGetUsage, { period, from, to }, hostname(), {})
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ devices: results }))
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

  const url = `http://127.0.0.1:${port}`
  if (!dashDir) {
    process.stdout.write(`\n  Dashboard UI is not built. Run: cd dash && npm install && npm run build\n`)
  }
  process.stdout.write(`\n  CodeBurn dashboard at ${url}\n  Press Ctrl+C to stop.\n\n`)
  if (opts.open) openBrowser(url)

  await new Promise<never>(() => {
    /* run until interrupted */
  })
}
