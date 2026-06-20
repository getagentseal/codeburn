import { randomBytes, createHash, timingSafeEqual } from 'crypto'

// Device identity is the SHA-256 of its self-signed TLS certificate
// (trust-on-first-use, like SSH/Syncthing). No certificate authority involved:
// once two devices have each other's fingerprint, that pin is the trust anchor.
export function certFingerprint(cert: Buffer | string): string {
  const buf = typeof cert === 'string' ? Buffer.from(cert) : cert
  return createHash('sha256').update(buf).digest('hex')
}

// Short, human-typed pairing PIN: 6 uniform digits. Rejection-sampled so the
// distribution is even (no modulo bias across 0..999999).
export function generatePin(): string {
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000
  let n = randomBytes(4).readUInt32BE(0)
  while (n >= limit) n = randomBytes(4).readUInt32BE(0)
  return (n % 1_000_000).toString().padStart(6, '0')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

// An open pairing window on the device being added: a one-time PIN that expires.
// `now` is injectable so the lifecycle is deterministic in tests.
export class PairingWindow {
  readonly pin: string
  readonly openedAt: number
  private used = false

  constructor(ttlMs = 60_000, now: number = Date.now(), pin: string = generatePin()) {
    this.ttlMs = ttlMs
    this.pin = pin
    this.openedAt = now
  }

  private readonly ttlMs: number

  isOpen(now: number = Date.now()): boolean {
    return !this.used && now - this.openedAt <= this.ttlMs
  }

  // Verify a submitted PIN. A correct match consumes the window (one-time use).
  verify(pin: string, now: number = Date.now()): boolean {
    if (!this.isOpen(now)) return false
    if (!constantTimeEqual(pin, this.pin)) return false
    this.used = true
    return true
  }
}

export type PairedPeer = {
  fingerprint: string
  name: string
  token: string
  pairedAt: number
}

// The devices this device trusts. A pull is authorized only when BOTH the
// bearer token AND the TLS peer fingerprint match the same paired peer, so a
// token stolen and replayed from a different device is useless on its own.
export class PeerStore {
  private byFingerprint = new Map<string, PairedPeer>()

  constructor(peers: PairedPeer[] = []) {
    for (const p of peers) this.byFingerprint.set(p.fingerprint, p)
  }

  list(): PairedPeer[] {
    return [...this.byFingerprint.values()]
  }

  pair(fingerprint: string, name: string, now: number = Date.now()): PairedPeer {
    const peer: PairedPeer = { fingerprint, name, token: mintToken(), pairedAt: now }
    this.byFingerprint.set(fingerprint, peer)
    return peer
  }

  authorize(token: string, fingerprint: string): boolean {
    const peer = this.byFingerprint.get(fingerprint)
    if (!peer) return false
    return constantTimeEqual(token, peer.token)
  }

  unpair(fingerprint: string): boolean {
    return this.byFingerprint.delete(fingerprint)
  }
}
