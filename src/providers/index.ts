import { claude } from './claude.js'
import { codex } from './codex.js'
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

const coreProviders: Provider[] = [claude, codex]

export async function getAllProviders(): Promise<Provider[]> {
  const cursor = await loadCursor()
  return cursor ? [...coreProviders, cursor] : [...coreProviders]
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
  return coreProviders.find(p => p.name === name)
}

