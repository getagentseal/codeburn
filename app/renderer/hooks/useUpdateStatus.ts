import { useEffect, useState } from 'react'

import { codeburn } from '../lib/ipc'
import type { UpdateStatus } from '../lib/types'

/**
 * Reads the main-process update-availability status once on mount and stays live
 * via the push event. Returns null until the first read resolves, or when the
 * bridge predates the feature (an older preload, or a test mock) — both degrade
 * to "no update", so callers can treat null as "nothing to show".
 */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    if (typeof codeburn.getUpdateStatus !== 'function') return
    let active = true
    codeburn.getUpdateStatus().then(next => { if (active) setStatus(next) }).catch(() => { /* offline — no nudge */ })
    const unsubscribe = typeof codeburn.onUpdateStatus === 'function'
      ? codeburn.onUpdateStatus(next => { if (active) setStatus(next) })
      : undefined
    return () => { active = false; unsubscribe?.() }
  }, [])
  return status
}

/** GitHub release page for a desktop tag — the fallback Download target when
 *  no single direct asset fits (Linux ships three formats) or the platform is
 *  unknown. https-only, so it passes the openExternal allowlist. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/getagentseal/codeburn/releases/tag/${tag}`
}

/** Official signed Windows distribution. The Store handles installation and
 *  updates, avoiding the unsigned GitHub installer and SmartScreen warning. */
export const MICROSOFT_STORE_URL = 'https://apps.microsoft.com/detail/9P0R4ZL5XMB8'

/**
 * Preferred install target for the running platform. macOS downloads the
 * matching release asset; Windows opens the signed Microsoft Store listing.
 * Returns null (callers fall back to the release page) for Linux — three
 * formats, the user picks — and for unknown platforms or a preload without
 * `arch`.
 */
export function directDownloadUrl(tag: string, platform: string | undefined, arch: string | undefined): string | null {
  const version = tag.startsWith('desktop-v') ? tag.slice('desktop-v'.length) : null
  if (!version) return null
  let file: string | null = null
  if (platform === 'darwin') {
    if (!arch) return null
    file = arch === 'arm64' ? `CodeBurn-${version}-arm64.dmg` : `CodeBurn-${version}.dmg`
  } else if (platform === 'win32') {
    return MICROSOFT_STORE_URL
  }
  if (!file) return null
  return `https://github.com/getagentseal/codeburn/releases/download/${tag}/${file}`
}

/** The Download click target: direct asset when determinable, else the page. */
export function updateDownloadUrl(tag: string): string {
  return directDownloadUrl(tag, codeburn.platform, codeburn.arch) ?? releasePageUrl(tag)
}
