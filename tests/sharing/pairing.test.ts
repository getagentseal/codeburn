import { describe, it, expect } from 'vitest'

import {
  certFingerprint,
  generatePin,
  constantTimeEqual,
  mintToken,
  PairingWindow,
  PeerStore,
} from '../../src/sharing/pairing.js'

describe('certFingerprint', () => {
  it('is a deterministic 64-char hex digest', () => {
    const fp = certFingerprint('cert-bytes')
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(certFingerprint('cert-bytes')).toBe(fp)
  })
  it('differs for different certs', () => {
    expect(certFingerprint('a')).not.toBe(certFingerprint('b'))
  })
})

describe('generatePin', () => {
  it('is always 6 digits', () => {
    for (let i = 0; i < 200; i++) expect(generatePin()).toMatch(/^\d{6}$/)
  })
  it('varies', () => {
    const pins = new Set(Array.from({ length: 50 }, () => generatePin()))
    expect(pins.size).toBeGreaterThan(1)
  })
})

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects different ones', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('mintToken', () => {
  it('is url-safe and unique', () => {
    const a = mintToken()
    const b = mintToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
  })
})

describe('PairingWindow', () => {
  it('accepts the correct PIN within the window', () => {
    const w = new PairingWindow(1000, 1000, '123456')
    expect(w.verify('123456', 1500)).toBe(true)
  })
  it('rejects a wrong PIN', () => {
    const w = new PairingWindow(1000, 1000, '123456')
    expect(w.verify('000000', 1200)).toBe(false)
  })
  it('rejects after the window expires', () => {
    const w = new PairingWindow(1000, 1000, '123456')
    expect(w.isOpen(3000)).toBe(false)
    expect(w.verify('123456', 3000)).toBe(false)
  })
  it('is one-time: a consumed PIN cannot be reused', () => {
    const w = new PairingWindow(10_000, 1000, '123456')
    expect(w.verify('123456', 1100)).toBe(true)
    expect(w.verify('123456', 1200)).toBe(false)
  })
  it('closes after too many wrong guesses (no brute force within the window)', () => {
    const w = new PairingWindow(10_000, 1000, '123456', 5)
    for (let i = 0; i < 5; i++) expect(w.verify('000000', 1000 + i)).toBe(false)
    // window is now locked even though the TTL has not expired
    expect(w.isOpen(1100)).toBe(false)
    // and the correct PIN no longer works
    expect(w.verify('123456', 1100)).toBe(false)
  })
})

describe('PeerStore', () => {
  it('authorizes only when token AND fingerprint both match the same peer', () => {
    const store = new PeerStore()
    const a = store.pair('fp-aaa', 'MacBook')
    const b = store.pair('fp-bbb', 'Mac Studio')

    // correct pairing
    expect(store.authorize(a.token, 'fp-aaa')).toBe(true)
    // right token, wrong device fingerprint -> denied (stolen-token defense)
    expect(store.authorize(a.token, 'fp-bbb')).toBe(false)
    // wrong token on the right device -> denied
    expect(store.authorize('not-the-token', 'fp-aaa')).toBe(false)
    // unknown device -> denied
    expect(store.authorize(a.token, 'fp-ccc')).toBe(false)
    expect(store.authorize(b.token, 'fp-bbb')).toBe(true)
  })

  it('revokes a peer on unpair', () => {
    const store = new PeerStore()
    const p = store.pair('fp-x', 'Laptop')
    expect(store.authorize(p.token, 'fp-x')).toBe(true)
    expect(store.unpair('fp-x')).toBe(true)
    expect(store.authorize(p.token, 'fp-x')).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('round-trips through serializable peer records', () => {
    const store = new PeerStore()
    store.pair('fp-1', 'A')
    const restored = new PeerStore(store.list())
    const peer = restored.list()[0]!
    expect(restored.authorize(peer.token, 'fp-1')).toBe(true)
  })
})
