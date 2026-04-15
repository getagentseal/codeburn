import { claude } from './claude.js'
import { codex } from './codex.js'
import { opencode } from './opencode.js'
import type { Provider, SessionSource } from './types.js'

export const providers: Provider[] = [claude, codex, opencode]

export async function discoverAllSessions(providerFilter?: string): Promise<SessionSource[]> {
  const filtered = providerFilter && providerFilter !== 'all'
    ? providers.filter(p => p.name === providerFilter)
    : providers
  const all: SessionSource[] = []
  for (const provider of filtered) {
    const sessions = await provider.discoverSessions()
    all.push(...sessions)
  }
  return all
}

export function getProvider(name: string): Provider | undefined {
  return providers.find(p => p.name === name)
}
