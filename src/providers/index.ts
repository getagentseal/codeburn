import { claude } from './claude.js'
import { codex } from './codex.js'
import { copilot } from './copilot.js'
import { droid } from './droid.js'
import { gemini } from './gemini.js'
import { kiloCode } from './kilo-code.js'
import { kiro } from './kiro.js'
import { openclaw } from './openclaw.js'
import { pi, omp } from './pi.js'
import { qwen } from './qwen.js'
import { rooCode } from './roo-code.js'
import type { Provider, SessionSource } from './types.js'

let antigravityProvider: Provider | null = null
let antigravityLoadAttempted = false

async function loadAntigravity(): Promise<Provider | null> {
  if (antigravityLoadAttempted) return antigravityProvider
  antigravityLoadAttempted = true
  try {
    const { antigravity } = await import('./antigravity.js')
    antigravityProvider = antigravity
    return antigravity
  } catch {
    return null
  }
}

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

let cursorAgentProvider: Provider | null = null
let cursorAgentLoadAttempted = false

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

async function loadCursorAgent(): Promise<Provider | null> {
  if (cursorAgentLoadAttempted) return cursorAgentProvider
  cursorAgentLoadAttempted = true
  try {
    const { cursor_agent } = await import('./cursor-agent.js')
    cursorAgentProvider = cursor_agent
    return cursor_agent
  } catch {
    return null
  }
}

const coreProviders: Provider[] = [claude, codex, copilot, droid, gemini, kiloCode, kiro, openclaw, pi, omp, qwen, rooCode]

export async function getAllProviders(): Promise<Provider[]> {
  const [ag, cursor, opencode, cursorAgent] = await Promise.all([loadAntigravity(), loadCursor(), loadOpenCode(), loadCursorAgent()])
  const all = [...coreProviders]
  if (ag) all.push(ag)
  if (cursor) all.push(cursor)
  if (opencode) all.push(opencode)
  if (cursorAgent) all.push(cursorAgent)
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
  if (name === 'antigravity') {
    const ag = await loadAntigravity()
    return ag ?? undefined
  }
  if (name === 'cursor') {
    const cursor = await loadCursor()
    return cursor ?? undefined
  }
  if (name === 'opencode') {
    const oc = await loadOpenCode()
    return oc ?? undefined
  }
  if (name === 'cursor-agent') {
    const ca = await loadCursorAgent()
    return ca ?? undefined
  }
  return coreProviders.find(p => p.name === name)
}
