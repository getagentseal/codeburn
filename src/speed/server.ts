import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { appendSpeedSample } from './store.js'
import { SpeedStreamObserver } from './stream.js'
import { validateSpeedSample, type SpeedHarness, type SpeedSample } from './types.js'

export type SpeedServer = { server: Server; url: string; close(): Promise<void> }

function publicRequest(req: IncomingMessage): boolean {
  // Browsers must not be able to use the loopback collector/proxy from a site.
  return !!req.headers.origin || !!req.headers['sec-fetch-site'] || req.method === 'OPTIONS'
}

async function ingest(req: IncomingMessage, res: ServerResponse, save: (sample: SpeedSample) => Promise<void>): Promise<void> {
  if (req.headers['x-codeburn-speed'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) {
    res.writeHead(403).end(); return
  }
  const buffers: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 8 * 1024 * 1024) { res.writeHead(413).end(); return }
    buffers.push(bytes)
  }
  let sample: SpeedSample
  try {
    sample = validateSpeedSample(JSON.parse(Buffer.concat(buffers).toString('utf8')))
    if (sample.source !== 'native') throw new Error('Only native samples may be ingested')
  } catch { res.writeHead(400).end('Invalid native speed sample'); return }
  try { await save(sample) } catch { res.writeHead(500).end('Could not save speed sample'); return }
  res.writeHead(204).end()
}

const hopHeaders = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'upgrade']

export async function startSpeedServer(opts: {
  port?: number
  file?: string
  // No upstream = native collector only. A proxy has one fixed harness and
  // upstream, so client headers/paths cannot change attribution or the host.
  harness?: SpeedHarness
  upstream?: string
  onSaveError?: () => void
}): Promise<SpeedServer> {
  let upstream: URL | undefined
  if (opts.upstream) {
    upstream = new URL(opts.upstream)
    if (upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('Upstream must be an origin URL without credentials, a path, query or fragment')
    if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname))) throw new Error('Use HTTPS upstream, or HTTP on loopback for a local provider')
    if (!opts.harness) throw new Error('Proxy requires a harness')
  }
  const pending = new Set<Promise<void>>()
  const activeRequests = new Set<(status: 'complete' | 'interrupted' | 'error') => void>()
  const save = (sample: SpeedSample): Promise<void> => {
    const p = appendSpeedSample(sample, opts.file)
    pending.add(p)
    void p.then(() => pending.delete(p), () => pending.delete(p))
    return p
  }
  const server = createServer((req, res) => {
    if (publicRequest(req) || !req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(403).end(); return }
    if (req.url === '/v1/speed' && req.method === 'POST') {
      void ingest(req, res, save).catch(() => { if (!res.headersSent) res.writeHead(400); res.end() })
      return
    }
    if (!upstream) { res.writeHead(404).end(); return }
    const observer = new SpeedStreamObserver(opts.harness!)
    const headers = { ...req.headers }
    const connectionFields = String(headers.connection || '').split(',').map(h => h.trim().toLowerCase())
    for (const name of [...hopHeaders, ...connectionFields, 'accept-encoding']) delete headers[name]
    const url = new URL(upstream)
    // Setting pathname rather than URL resolution prevents an absolute client
    // URL, double slash, or backslash from selecting a different upstream.
    const [path, ...query] = req.url.split('?')
    url.pathname = path
    url.search = query.join('?')
    const generationPath = /\/(messages|responses|chat\/completions)$/.test(url.pathname)
    let isSse = false
    let done = false
    let head = Buffer.alloc(0)
    const finish = (status: 'complete' | 'interrupted' | 'error') => {
      if (done) return
      done = true
      activeRequests.delete(finish)
      const sample = observer.finish(status)
      if (sample.model === 'unknown' && head.length) {
        try { observer.setModel((JSON.parse(head.toString('utf8')) as { model?: unknown }).model) } catch { /* response may identify the model */ }
      }
      head = Buffer.alloc(0)
      if (!isSse && !generationPath) return
      void save(sample).catch(() => opts.onSaveError?.())
    }
    activeRequests.add(finish)
    const remote = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers }
      const responseConnectionFields = String(responseHeaders.connection || '').split(',').map(h => h.trim().toLowerCase())
      for (const name of [...hopHeaders, ...responseConnectionFields]) delete responseHeaders[name]
      res.writeHead(response.statusCode || 502, responseHeaders)
      isSse = !!response.headers['content-type']?.includes('text/event-stream') && !response.headers['content-encoding']
      if (isSse) response.on('data', (bytes: Buffer) => observer.feed(bytes))
      response.on('end', () => finish((response.statusCode || 502) >= 400 ? 'error' : 'complete'))
      response.on('error', () => { finish('error'); res.destroy() })
      response.on('aborted', () => { finish('interrupted'); res.destroy() })
      response.pipe(res)
    })
    remote.setTimeout(300_000, () => remote.destroy(new Error('Upstream idle timeout')))
    remote.on('error', () => {
      finish('error')
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.on('data', (bytes: Buffer) => {
      // Ephemeral, bounded model lookup only; never stored or logged.
      if (generationPath && head.length < 64 * 1024) head = Buffer.concat([head, bytes]).subarray(0, 64 * 1024)
    })
    req.on('aborted', () => { finish('interrupted'); remote.destroy() })
    res.on('close', () => { if (!res.writableFinished) { finish('interrupted'); remote.destroy() } })
    req.pipe(remote)
  })
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n') })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Collector did not bind a TCP port')
  return { server, url: `http://127.0.0.1:${address.port}`, async close() {
    // Finalize before closing sockets: their 'close' callbacks can run after
    // server.close(), otherwise the final interrupted sample misses the drain.
    for (const finish of activeRequests) finish('interrupted')
    const closing = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    server.closeAllConnections()
    await closing
    await Promise.allSettled([...pending])
  } }
}
