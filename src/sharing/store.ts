import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

import { getConfigFilePath } from '../config.js'
import type { PairedPeer } from './pairing.js'

// A device this host can pull FROM: its address, the pinned server-cert
// fingerprint, and the token issued to us during pairing.
export type RemoteDevice = {
  name: string
  host: string
  port: number
  fingerprint: string
  token: string
  addedAt: number
}

// Sharing state lives next to the main config file.
export function getSharingDir(): string {
  return join(dirname(getConfigFilePath()), 'sharing')
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2))
}

// Peers allowed to pull from this device (the sharing side, used by ShareServer).
export function loadPeers(dir: string = getSharingDir()): Promise<PairedPeer[]> {
  return readJson(join(dir, 'paired-peers.json'), [] as PairedPeer[])
}
export function savePeers(peers: PairedPeer[], dir: string = getSharingDir()): Promise<void> {
  return writeJson(join(dir, 'paired-peers.json'), peers)
}

// Devices this host pulls from (the host side, used by `codeburn devices`).
export function loadRemotes(dir: string = getSharingDir()): Promise<RemoteDevice[]> {
  return readJson(join(dir, 'remote-devices.json'), [] as RemoteDevice[])
}
export function saveRemotes(remotes: RemoteDevice[], dir: string = getSharingDir()): Promise<void> {
  return writeJson(join(dir, 'remote-devices.json'), remotes)
}
