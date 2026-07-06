import { request } from 'https'
import type { TLSSocket } from 'tls'

import { certFingerprint } from './pairing.js'
import type { Identity } from './identity.js'
import type { UsageQuery } from './share-server.js'

// req.setTimeout only arms once connected; it does not abort a stalled TCP
// connect, so an unreachable peer would otherwise ride the OS connect timeout
// (~75s on macOS). Cap the TCP-connect phase separately; it clears the instant
// the socket connects, so the TLS handshake and the read/approval timeouts
// (req.setTimeout) are unaffected even over a slow VPN link.
const CONNECT_TIMEOUT_MS = 3000

export type PeerEndpoint = {
  identity: Identity // our own identity (we present our cert so the peer can bind a token to us)
  host: string
  port: number
  // When set, the connection is aborted unless the peer's cert fingerprint matches.
  expectedFingerprint?: string
}

export type Response = { status: number; serverFingerprint: string; json: unknown }

// One request to a peer. Self-signed certs are accepted at the TLS layer
// (rejectUnauthorized:false) but the peer is authenticated by pinning its cert
// fingerprint, the SSH/Syncthing trust-on-first-use model.
function call(
  ep: PeerEndpoint,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  timeoutMs = 15000,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: ep.host,
        port: ep.port,
        method,
        path,
        key: ep.identity.key,
        cert: ep.identity.cert,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        // Fresh socket per request so the pinned-fingerprint check always reads
        // this connection's certificate, never a pooled/keep-alive one.
        agent: false,
        headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        const cert = (res.socket as TLSSocket).getPeerCertificate?.()
        const serverFingerprint = cert?.raw ? certFingerprint(cert.raw) : ''
        if (ep.expectedFingerprint && serverFingerprint !== ep.expectedFingerprint) {
          res.destroy()
          reject(new Error('server fingerprint mismatch'))
          return
        }
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, serverFingerprint, json: safeJson(data) }))
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('peer timed out')))
    const connectTimer = setTimeout(() => req.destroy(new Error('peer unreachable')), CONNECT_TIMEOUT_MS)
    connectTimer.unref()
    req.once('socket', (socket) => {
      const clear = () => clearTimeout(connectTimer)
      socket.once('connect', clear)
      socket.once('secureConnect', clear)
    })
    req.once('close', () => clearTimeout(connectTimer))
    if (body) req.write(body)
    req.end()
  })
}

export function hello(ep: PeerEndpoint): Promise<Response> {
  return call(ep, 'GET', '/api/peer/hello')
}

export function pair(ep: PeerEndpoint, pin: string, name: string): Promise<Response> {
  return call(ep, 'POST', '/api/peer/pair', {}, JSON.stringify({ pin, name }))
}

// Approve-style pairing: no PIN. The peer prompts its user to approve; this
// request stays open until they accept or decline.
export function pairRequest(ep: PeerEndpoint, name: string): Promise<Response> {
  // Stays open while the peer's user decides; give it longer than the server's
  // 60s approval prompt.
  return call(ep, 'POST', '/api/peer/pair-request', {}, JSON.stringify({ name }), 65_000)
}

export function fetchUsage(ep: PeerEndpoint, token: string, query: UsageQuery = {}): Promise<Response> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v)
  const qs = params.toString()
  return call(ep, 'GET', `/api/usage${qs ? `?${qs}` : ''}`, { authorization: `Bearer ${token}` })
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
