/**
 * codeburn sync — config file management.
 *
 * Stores non-secret sync configuration at ~/.config/codeburn/sync.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface SyncConfig {
  baseUrl: string
  clientId: string
  tracesPath: string
  issuer: string
  lastSync?: string
}

function configDir(): string {
  return join(homedir(), '.config', 'codeburn')
}

function configPath(): string {
  return join(configDir(), 'sync.json')
}

export function readSyncConfig(): SyncConfig | null {
  const path = configPath()
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>

    if (typeof data.baseUrl !== 'string' || typeof data.clientId !== 'string') {
      return null
    }

    return {
      baseUrl: data.baseUrl,
      clientId: data.clientId,
      tracesPath: typeof data.tracesPath === 'string' ? data.tracesPath : '/v1/traces',
      issuer: typeof data.issuer === 'string' ? data.issuer : '',
      lastSync: typeof data.lastSync === 'string' ? data.lastSync : undefined,
    }
  } catch {
    return null
  }
}

export function writeSyncConfig(config: SyncConfig): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n')
}

export function updateLastSync(): void {
  const config = readSyncConfig()
  if (!config) return
  config.lastSync = new Date().toISOString()
  writeSyncConfig(config)
}

export function deleteSyncConfig(): void {
  try { unlinkSync(configPath()) } catch { /* may not exist */ }
}
