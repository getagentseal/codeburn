import { createServer, type Server } from 'https'
import type { IncomingMessage, ServerResponse } from 'http'
import type { TLSSocket } from 'tls'
import type { AddressInfo } from 'net'

import { UsageQueryError } from '../cli-date.js'
import { certFingerprint, pairingCode, PeerStore, PairingWindow } from './pairing.js'
import type { Identity } from './identity.js'

export type UsageQuery = { period?: string; from?: string; to?: string }

// An approve-style pairing request, surfaced to the user on the sharing device.
export type PairRequest = { name: string; fingerprint: string; code: string }

export type ShareServerOptions = {
  identity: Identity
  peers: PeerStore
  getUsage: (query: UsageQuery) => Promise<unknown>
  // Called after a successful pairing so the caller can persist the peer list.
  onPaired?: () => void
  // Enables the interactive approve flow (POST /api/peer/pair-request): return
  // true to accept. The user confirms the matching `code` shown on both devices.
  approve?: (req: PairRequest) => Promise<boolean>
}

// A device's HTTPS sharing endpoint. Mutual TLS: the server presents its own
// self-signed cert (clients pin its fingerprint) and requests the client's cert
// so it can bind tokens to the caller's fingerprint. A pull is served only when
// the bearer token AND the client cert fingerprint match the same paired peer.
export class ShareServer {
  readonly server: Server
  private pairing: PairingWindow | null = null

  constructor(private readonly opts: ShareServerOptions) {
    this.server = createServer(
      { key: opts.identity.key, cert: opts.identity.cert, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        void this.handle(req, res)
      },
    )
    // Swallow server-level socket/TLS errors (e.g. a malformed handshake from a
    // LAN peer) so they can never crash the host process. `listen()` attaches
    // its own one-time handler for bind failures.
    this.server.on('error', () => {})
    this.server.on('tlsClientError', () => {})
  }

  // Open a one-time pairing window and return the PIN to show the user.
  openPairing(ttlMs = 60_000): string {
    this.pairing = new PairingWindow(ttlMs)
    return this.pairing.pin
  }

  closePairing(): void {
    this.pairing = null
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => resolve((this.server.address() as AddressInfo).port))
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private clientFingerprint(req: IncomingMessage): string | null {
    const cert = (req.socket as TLSSocket).getPeerCertificate?.()
    if (!cert || !cert.raw) return null
    return certFingerprint(cert.raw)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://localhost')
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      await this.route(url, req, res, json)
    } catch (err) {
      // Never leave a request hanging (a hung peer makes the caller time out
      // and drop this device); always answer, even on an internal error.
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err)
        json(err instanceof UsageQueryError ? 400 : 500, { error: message })
      }
    }
  }

  private async route(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
    json: (code: number, body: unknown) => void,
  ): Promise<void> {

    // Unauthenticated: just enough for a joiner to learn who this is and whether
    // pairing is currently open. No usage data here.
    if (url.pathname === '/api/peer/hello' && req.method === 'GET') {
      json(200, {
        fingerprint: this.opts.identity.fingerprint,
        name: this.opts.identity.name,
        pairingOpen: !!this.pairing?.isOpen(),
      })
      return
    }

    if (url.pathname === '/api/peer/pair' && req.method === 'POST') {
      const clientFp = this.clientFingerprint(req)
      if (!clientFp) {
        json(400, { error: 'client certificate required' })
        return
      }
      const body = safeJson(await readBody(req)) as { pin?: unknown; name?: unknown } | null
      const pin = typeof body?.pin === 'string' ? body.pin : ''
      const name = typeof body?.name === 'string' ? body.name : 'device'
      if (!this.pairing || !this.pairing.verify(pin)) {
        json(401, { error: 'invalid or expired PIN' })
        return
      }
      this.pairing = null
      const peer = this.opts.peers.pair(clientFp, name)
      this.opts.onPaired?.()
      json(200, { token: peer.token, name: this.opts.identity.name, fingerprint: this.opts.identity.fingerprint })
      return
    }

    if (url.pathname === '/api/peer/pair-request' && req.method === 'POST') {
      const clientFp = this.clientFingerprint(req)
      if (!clientFp) {
        json(400, { error: 'client certificate required' })
        return
      }
      if (!this.opts.approve) {
        json(403, { error: 'this device is not accepting new pairings' })
        return
      }
      const body = safeJson(await readBody(req)) as { name?: unknown } | null
      const name = typeof body?.name === 'string' ? body.name : 'device'
      const code = pairingCode(this.opts.identity.fingerprint, clientFp)
      const approved = await this.opts.approve({ name, fingerprint: clientFp, code })
      if (!approved) {
        json(403, { error: 'pairing declined' })
        return
      }
      const peer = this.opts.peers.pair(clientFp, name)
      this.opts.onPaired?.()
      json(200, { token: peer.token, name: this.opts.identity.name, fingerprint: this.opts.identity.fingerprint, code })
      return
    }

    if (url.pathname === '/api/usage' && req.method === 'GET') {
      const clientFp = this.clientFingerprint(req)
      const token = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '')
      if (!clientFp || !token || !this.opts.peers.authorize(token, clientFp)) {
        json(401, { error: 'unauthorized' })
        return
      }
      const payload = await this.opts.getUsage({
        period: url.searchParams.get('period') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      })
      json(200, payload)
      return
    }

    json(404, { error: 'not found' })
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy() // guard against oversized bodies
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(data))
  })
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
