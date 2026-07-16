/**
 * codeburn sync — OS credential storage.
 *
 * Stores refresh tokens in the OS keychain.
 * Falls back to a 0600 file when no keychain is available.
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SERVICE_NAME = 'codeburn-sync'
const ACCOUNT_NAME = 'refresh-token'

export type StorageMethod = 'keychain' | 'secret-tool' | 'dpapi' | 'file'

export interface CredentialStore {
  store(token: string): void
  retrieve(): string | null
  delete(): void
  method(): StorageMethod
}

// --- macOS Keychain ---

class KeychainStore implements CredentialStore {
  store(token: string): void {
    // Delete existing first (add-generic-password fails if entry exists)
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME], { stdio: 'pipe' })
    } catch { /* may not exist */ }

    // Token passed as arg to execFileSync (no shell interpolation).
    // Note: still briefly visible in process args on macOS; `security` has no
    // stdin mode for -w with non-interactive use, so this is the best available.
    execFileSync('security', ['add-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w', token], { stdio: 'pipe' })
  }

  retrieve(): string | null {
    try {
      const result = execFileSync(
        'security',
        ['find-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      )
      return result.trim() || null
    } catch {
      return null
    }
  }

  delete(): void {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME], { stdio: 'pipe' })
    } catch { /* may not exist */ }
  }

  method(): StorageMethod { return 'keychain' }
}

// --- Linux libsecret ---

class SecretToolStore implements CredentialStore {
  store(token: string): void {
    // Token passed via stdin — never appears in argv or shell string
    execFileSync(
      'secret-tool',
      ['store', `--label=${SERVICE_NAME}`, 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
      { input: token, stdio: ['pipe', 'pipe', 'pipe'] }
    )
  }

  retrieve(): string | null {
    try {
      const result = execFileSync(
        'secret-tool',
        ['lookup', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      )
      return result.trim() || null
    } catch {
      return null
    }
  }

  delete(): void {
    try {
      execFileSync('secret-tool', ['clear', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME], { stdio: 'pipe' })
    } catch { /* may not exist */ }
  }

  method(): StorageMethod { return 'secret-tool' }
}

// --- Windows DPAPI ---

class DpapiStore implements CredentialStore {
  private filePath: string

  constructor() {
    this.filePath = join(homedir(), '.config', 'codeburn', '.sync-token-dpapi')
  }

  store(token: string): void {
    // Token passed via environment variable — never in argv or command string
    const ps = `$s = ConvertTo-SecureString $env:CODEBURN_SYNC_TOKEN -AsPlainText -Force; ConvertFrom-SecureString $s`
    const encrypted = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEBURN_SYNC_TOKEN: token },
    }).trim()

    const dir = join(homedir(), '.config', 'codeburn')
    mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, encrypted, { mode: 0o600 })
  }

  retrieve(): string | null {
    if (!existsSync(this.filePath)) return null
    try {
      const encrypted = readFileSync(this.filePath, 'utf-8').trim()
      const ps = `$s = ConvertTo-SecureString $env:CODEBURN_SYNC_BLOB; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
      const result = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CODEBURN_SYNC_BLOB: encrypted },
      })
      return result.trim() || null
    } catch {
      return null
    }
  }

  delete(): void {
    try { unlinkSync(this.filePath) } catch { /* may not exist */ }
  }

  method(): StorageMethod { return 'dpapi' }
}

// --- File Fallback ---

class FileStore implements CredentialStore {
  private filePath: string

  constructor() {
    this.filePath = join(homedir(), '.config', 'codeburn', '.sync-token')
  }

  store(token: string): void {
    const dir = join(homedir(), '.config', 'codeburn')
    mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, token, { mode: 0o600 })
    // Ensure permissions (writeFile mode doesn't always work on existing files)
    try { chmodSync(this.filePath, 0o600) } catch {}
  }

  retrieve(): string | null {
    if (!existsSync(this.filePath)) return null
    try {
      return readFileSync(this.filePath, 'utf-8').trim() || null
    } catch {
      return null
    }
  }

  delete(): void {
    try { unlinkSync(this.filePath) } catch { /* may not exist */ }
  }

  method(): StorageMethod { return 'file' }
}

// --- Factory ---

function isCommandAvailable(cmd: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(probe, [cmd], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function createCredentialStore(): CredentialStore {
  // Test/CI escape hatch: force the file store (respects $HOME, so tests
  // can fully isolate with a temp HOME). Without this, darwin machines
  // would hit the real login keychain during the offline test suite.
  if (process.env.CODEBURN_SYNC_TOKEN_STORE === 'file') {
    return new FileStore()
  }

  if (process.platform === 'darwin') {
    return new KeychainStore()
  }

  if (process.platform === 'win32') {
    return new DpapiStore()
  }

  // Linux: try secret-tool, fall back to file
  if (isCommandAvailable('secret-tool')) {
    // Also verify the keyring daemon is running
    try {
      execFileSync('secret-tool', ['lookup', 'service', '__codeburn_probe__', 'account', '__probe__'], { stdio: 'pipe' })
      return new SecretToolStore()
    } catch (err) {
      // Exit code 1 = not found (keyring works). Other errors = keyring not running.
      if ((err as { status?: number }).status === 1) {
        return new SecretToolStore()
      }
    }
  }

  return new FileStore()
}
