import { claude } from './claude.js'
import { codex } from './codex.js'
import { copilot } from './copilot.js'
import { openclaw } from './openclaw.js'
import { pi } from './pi.js'
import type { Provider, SessionSource } from './types.js'

let cursorProvider: Provider | null = null
let cursorLoadAttempted = false

async function loadCursor(): Promise<Provider | null> {
  if (cursorLoadAttempted) return cursorProvider
  cursorLoadAttempted = true
  try {
    const { cursor } = await import('./cursor.js')
    cursorProvider = cursor
    return cursor
  } catch {
    return null
  }
}

let opencodeProvider: Provider | null = null
let opencodeLoadAttempted = false

async function loadOpenCode(): Promise<Provider | null> {
  if (opencodeLoadAttempted) return opencodeProvider
  opencodeLoadAttempted = true
  try {
    const { opencode } = await import('./opencode.js')
    opencodeProvider = opencode
    return opencode
  } catch {
    return null
  }
}

const coreProviders: Provider[] = [claude, codex, copilot, openclaw, pi]

export async function getAllProviders(): Promise<Provider[]> {
  const [cursor, opencode] = await Promise.all([loadCursor(), loadOpenCode()])
  const all = [...coreProviders]
  if (cursor) all.push(cursor)
  if (opencode) all.push(opencode)
  return all
}

export const providers = coreProviders

export async function discoverAllSessions(providerFilter?: string): Promise<SessionSource[]> {
  const allProviders = await getAllProviders()
  const filtered = providerFilter && providerFilter !== 'all'
    ? allProviders.filter(p => p.name === providerFilter)
    : allProviders
  const all: SessionSource[] = []
  for (const provider of filtered) {
    const sessions = await provider.discoverSessions()
    all.push(...sessions)
  }
  return all
}

export async function getProvider(name: string): Promise<Provider | undefined> {
  if (name === 'cursor') {
    const cursor = await loadCursor()
    return cursor ?? undefined
  }
  if (name === 'opencode') {
    const oc = await loadOpenCode()
    return oc ?? undefined
  }
  return coreProviders.find(p => p.name === name)
}
