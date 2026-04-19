import { auggie } from './auggie.js'
import type { Provider, SessionSource } from './types.js'

export const providers: Provider[] = [auggie]

export function getProvider(name: string): Provider | undefined {
  return providers.find(p => p.name === name)
}

export function getAllProviders(): Provider[] {
  return providers
}

export async function discoverAllSessions(): Promise<SessionSource[]> {
  const all: SessionSource[] = []
  for (const provider of providers) {
    const sessions = await provider.discoverSessions()
    all.push(...sessions)
  }
  return all
}
