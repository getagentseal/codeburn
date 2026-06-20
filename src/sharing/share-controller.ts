import { randomUUID } from 'crypto'

import { loadOrCreateIdentity, type Identity } from './identity.js'
import { PeerStore } from './pairing.js'
import { ShareServer, type PairRequest, type UsageQuery } from './share-server.js'
import { advertise } from './discovery.js'
import { getSharingDir, loadPeers, savePeers } from './store.js'

export type PendingPairing = { id: string; name: string; code: string }
export type ShareStatus = {
  sharing: boolean
  name: string
  port: number
  always: boolean
  peers: number
  pending: PendingPairing[]
}

const IDLE_TIMEOUT_MS = 10 * 60_000

// Runs the secure share server inside the dashboard process so the user can
// turn sharing on/off from the browser. Incoming approve-style pairings are
// queued and surfaced to the UI instead of prompting a terminal.
export class ShareController {
  private server: ShareServer | null = null
  private ad: ReturnType<typeof advertise> | null = null
  private peers: PeerStore | null = null
  private identity: Identity | null = null
  private always = false
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private lastActivity = 0
  private readonly dir = getSharingDir()
  private readonly pending = new Map<
    string,
    { name: string; code: string; fingerprint: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private readonly getUsage: (q: UsageQuery) => Promise<unknown>,
    private readonly port = 7777,
  ) {}

  private async getIdentity(): Promise<Identity> {
    if (!this.identity) this.identity = await loadOrCreateIdentity(this.dir)
    return this.identity
  }

  isSharing(): boolean {
    return !!this.server
  }

  async start(always: boolean): Promise<void> {
    if (this.server) {
      this.always = always
      this.refreshIdleWatch()
      return
    }
    const identity = await this.getIdentity()
    this.peers = new PeerStore(await loadPeers(this.dir))
    const server = new ShareServer({
      identity,
      peers: this.peers,
      getUsage: this.getUsage,
      onPaired: () => {
        if (this.peers) void savePeers(this.peers.list(), this.dir)
      },
      approve: (req) => this.enqueueApproval(req),
    })
    // listen() can reject (e.g. EADDRINUSE); only commit state after it binds,
    // so a failed start never leaves us reporting always/sharing incorrectly.
    await server.listen(this.port, '0.0.0.0')
    this.always = always
    this.server = server
    this.ad = advertise({ name: identity.name, port: this.port, fingerprint: identity.fingerprint })
    this.lastActivity = Date.now()
    server.server.on('request', () => {
      this.lastActivity = Date.now()
    })
    this.refreshIdleWatch()
  }

  private refreshIdleWatch(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    if (this.always) return
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) void this.stop()
    }, 30_000)
    this.idleTimer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve(false)
    }
    this.pending.clear()
    await this.ad?.stop().catch(() => {})
    await this.server?.close().catch(() => {})
    this.ad = null
    this.server = null
  }

  private enqueueApproval(req: PairRequest): Promise<boolean> {
    // One outstanding request per device, and a hard cap, so a LAN peer cannot
    // flood the approval prompt or bury a legitimate request.
    for (const p of this.pending.values()) if (p.fingerprint === req.fingerprint) return Promise.resolve(false)
    if (this.pending.size >= 8) return Promise.resolve(false)
    return new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(false)
      }, 60_000)
      timer.unref?.()
      this.pending.set(id, { name: req.name, code: req.code, fingerprint: req.fingerprint, resolve, timer })
    })
  }

  listPending(): PendingPairing[] {
    return [...this.pending.entries()].map(([id, p]) => ({ id, name: p.name, code: p.code }))
  }

  resolvePending(id: string, approve: boolean): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(approve)
    return true
  }

  async status(): Promise<ShareStatus> {
    const identity = await this.getIdentity()
    const peers = this.peers ? this.peers.list().length : (await loadPeers(this.dir)).length
    return {
      sharing: this.isSharing(),
      name: identity.name,
      port: this.port,
      always: this.always,
      peers,
      pending: this.listPending(),
    }
  }
}
