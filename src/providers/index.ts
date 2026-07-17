import { claude } from './claude.js'
import { cline } from './cline.js'
import { codewhale } from './codewhale.js'
import { codebuff } from './codebuff.js'
import { codex } from './codex.js'
import { copilot } from './copilot.js'
import { droid } from './droid.js'
import { devin } from './devin.js'
import { gemini } from './gemini.js'
import { hermes } from './hermes.js'
import { ibmBob } from './ibm-bob.js'
import { kiloCode } from './kilo-code.js'
import { kiro } from './kiro.js'
import { kimi } from './kimi.js'
import { lingtaiTui } from './lingtai-tui.js'
import { mistralVibe } from './mistral-vibe.js'
import { mux } from './mux.js'
import { openclaw } from './openclaw.js'
import { openDesign } from './open-design.js'
import { pi, omp } from './pi.js'
import { qwen } from './qwen.js'
import { quickdesk } from './quickdesk.js'
import { rooCode } from './roo-code.js'
import { zerostack } from './zerostack.js'
import { grok } from './grok.js'
import type { Provider, SessionSource } from './types.js'

let antigravityProvider: Provider | null = null
let antigravityLoadAttempted = false
let warpProvider: Provider | null = null
let warpLoadAttempted = false

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

async function loadWarp(): Promise<Provider | null> {
  if (warpLoadAttempted) return warpProvider
  warpLoadAttempted = true
  try {
    const { warp } = await import('./warp.js')
    warpProvider = warp
    return warp
  } catch {
    return null
  }
}

let forgeProvider: Provider | null = null
let forgeLoadAttempted = false

async function loadForge(): Promise<Provider | null> {
  if (forgeLoadAttempted) return forgeProvider
  forgeLoadAttempted = true
  try {
    const { forge } = await import('./forge.js')
    forgeProvider = forge
    return forge
  } catch {
    return null
  }
}

let gooseProvider: Provider | null = null
let gooseLoadAttempted = false

async function loadGoose(): Promise<Provider | null> {
  if (gooseLoadAttempted) return gooseProvider
  gooseLoadAttempted = true
  try {
    const { goose } = await import('./goose.js')
    gooseProvider = goose
    return goose
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

let crushProvider: Provider | null = null
let crushLoadAttempted = false

let vercelGatewayProvider: Provider | null = null
let vercelGatewayLoadAttempted = false

async function loadVercelGateway(): Promise<Provider | null> {
  if (vercelGatewayLoadAttempted) return vercelGatewayProvider
  vercelGatewayLoadAttempted = true
  try {
    const { vercelGateway } = await import('./vercel-gateway.js')
    vercelGatewayProvider = vercelGateway
    return vercelGateway
  } catch {
    return null
  }
}

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

async function loadCrush(): Promise<Provider | null> {
  if (crushLoadAttempted) return crushProvider
  crushLoadAttempted = true
  try {
    const { crush } = await import('./crush.js')
    crushProvider = crush
    return crush
  } catch {
    return null
  }
}

let zcodeProvider: Provider | null = null
let zcodeLoadAttempted = false

async function loadZcode(): Promise<Provider | null> {
  if (zcodeLoadAttempted) return zcodeProvider
  zcodeLoadAttempted = true
  try {
    const { zcode } = await import('./zcode.js')
    zcodeProvider = zcode
    return zcode
  } catch {
    return null
  }
}

let zedProvider: Provider | null = null
let zedLoadAttempted = false

async function loadZed(): Promise<Provider | null> {
  if (zedLoadAttempted) return zedProvider
  zedLoadAttempted = true
  try {
    const { zed } = await import('./zed.js')
    zedProvider = zed
    return zed
  } catch {
    return null
  }
}

const coreProviders: Provider[] = [claude, cline, codewhale, codebuff, codex, copilot, devin, droid, gemini, hermes, ibmBob, kiloCode, kiro, kimi, lingtaiTui, mistralVibe, mux, openclaw, openDesign, pi, omp, qwen, quickdesk, rooCode, zerostack, grok]

// Lazily loaded providers, listed by name so --provider validation works even
// when an optional module fails to load. Must stay in sync with getAllProviders.
const lazyProviderNames = ['antigravity', 'forge', 'goose', 'cursor', 'opencode', 'cursor-agent', 'crush', 'warp', 'vercel-gateway', 'zcode', 'zed']

// Canonical set of every provider name (core + lazy), used to validate the
// --provider CLI flag. Computed lazily so importing this module never depends on
// every provider object being defined at load time (e.g. under test mocks).
let allProviderNamesCache: string[] | undefined
export function allProviderNames(): readonly string[] {
  allProviderNamesCache ??= [
    ...coreProviders.map(p => p.name),
    ...lazyProviderNames,
  ].sort()
  return allProviderNamesCache
}

export async function getAllProviders(): Promise<Provider[]> {
  const [ag, forge, gs, cursor, opencode, cursorAgent, crush, warp, vercelGw, zc, zd] = await Promise.all([
    loadAntigravity(), loadForge(), loadGoose(), loadCursor(), loadOpenCode(), loadCursorAgent(), loadCrush(), loadWarp(), loadVercelGateway(), loadZcode(), loadZed(),
  ])
  const all = [...coreProviders]
  if (ag) all.push(ag)
  if (forge) all.push(forge)
  if (gs) all.push(gs)
  if (cursor) all.push(cursor)
  if (opencode) all.push(opencode)
  if (cursorAgent) all.push(cursorAgent)
  if (crush) all.push(crush)
  if (warp) all.push(warp)
  if (vercelGw) all.push(vercelGw)
  if (zc) all.push(zc)
  if (zd) all.push(zd)
  return all
}

export const providers = coreProviders

// Isolate one provider's discovery. A provider that throws (a crafted/corrupt
// file reaching a string op, an unexpected on-disk shape) must never take down
// the whole scan and blank every other provider's usage. Warn once per
// provider per run, then skip it. Mirrors the parse-failure isolation already
// used per-file in parser.ts.
const warnedDiscoveryFailures = new Set<string>()
export async function safeDiscoverSessions(provider: Provider): Promise<SessionSource[]> {
  try {
    return await provider.discoverSessions()
  } catch (err) {
    if (!warnedDiscoveryFailures.has(provider.name)) {
      warnedDiscoveryFailures.add(provider.name)
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `codeburn: skipped ${provider.name} discovery after an error: ${msg}\n`
      )
    }
    return []
  }
}

export async function discoverAllSessions(
  providerFilter?: string,
  // Injectable for tests so the isolation loop itself is exercised, not just
  // the helper. Defaults to the real registry.
  providerList?: Provider[],
): Promise<SessionSource[]> {
  const allProviders = providerList ?? await getAllProviders()
  const filtered = providerFilter && providerFilter !== 'all'
    ? allProviders.filter(p => p.name === providerFilter)
    : allProviders
  const all: SessionSource[] = []
  for (const provider of filtered) {
    const sessions = await safeDiscoverSessions(provider)
    all.push(...sessions)
  }
  return all
}

export async function getProvider(name: string): Promise<Provider | undefined> {
  if (name === 'antigravity') {
    const ag = await loadAntigravity()
    return ag ?? undefined
  }
  if (name === 'forge') {
    const forge = await loadForge()
    return forge ?? undefined
  }
  if (name === 'goose') {
    const gs = await loadGoose()
    return gs ?? undefined
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
  if (name === 'crush') {
    const c = await loadCrush()
    return c ?? undefined
  }
  if (name === 'warp') {
    const w = await loadWarp()
    return w ?? undefined
  }
  if (name === 'vercel-gateway') {
    const vg = await loadVercelGateway()
    return vg ?? undefined
  }
  if (name === 'zcode') {
    const z = await loadZcode()
    return z ?? undefined
  }
  if (name === 'zed') {
    const z = await loadZed()
    return z ?? undefined
  }
  return coreProviders.find(p => p.name === name)
}
