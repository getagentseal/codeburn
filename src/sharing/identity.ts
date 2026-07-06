import * as selfsigned from 'selfsigned'
import { X509Certificate } from 'crypto'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { hostname } from 'os'

import { certFingerprint } from './pairing.js'

// A device's stable identity: a self-signed TLS keypair whose certificate
// fingerprint is the trust anchor (trust-on-first-use). No CA.
export type Identity = {
  key: string // private key PEM
  cert: string // certificate PEM
  fingerprint: string // SHA-256 hex of the certificate DER
  name: string // human label (defaults to the hostname)
}

export async function generateIdentity(name: string = hostname()): Promise<Identity> {
  const attrs = [{ name: 'commonName', value: 'codeburn-device' }]
  // @types/selfsigned is missing `days`; the runtime accepts it. selfsigned >=5
  // resolves a Promise of { private, public, cert, fingerprint }.
  const genOpts = { days: 3650, keySize: 2048, algorithm: 'sha256' } as unknown as Parameters<
    typeof selfsigned.generate
  >[1]
  const pems = (await (selfsigned.generate(attrs, genOpts) as unknown as Promise<{ private: string; cert: string }>))
  const der = new X509Certificate(pems.cert).raw
  return { key: pems.private, cert: pems.cert, fingerprint: certFingerprint(der), name }
}

// Load the device identity from `dir`, creating and persisting it on first run.
export async function loadOrCreateIdentity(dir: string, name?: string): Promise<Identity> {
  const keyPath = join(dir, 'device-key.pem')
  const certPath = join(dir, 'device-cert.pem')
  const namePath = join(dir, 'device-name')

  if (existsSync(keyPath) && existsSync(certPath)) {
    const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')])
    let resolvedName = name ?? hostname()
    try {
      const stored = (await readFile(namePath, 'utf8')).trim()
      if (stored) resolvedName = name ?? stored
    } catch {
      /* no stored name yet */
    }
    const der = new X509Certificate(cert).raw
    return { key, cert, fingerprint: certFingerprint(der), name: resolvedName }
  }

  const id = await generateIdentity(name)
  await mkdir(dir, { recursive: true })
  await Promise.all([
    writeFile(keyPath, id.key, { mode: 0o600 }),
    writeFile(certPath, id.cert),
    writeFile(namePath, id.name),
  ])
  return id
}
