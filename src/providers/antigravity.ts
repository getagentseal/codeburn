import { readdir, readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { homedir } from 'os'
import https from 'https'

import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations')
const CACHE_VERSION = 2

const RPC_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

type ServerInfo = {
  port: number
  csrfToken: string
}

type ModelMap = Record<string, string>

type UsageEntry = {
  model: string
  inputTokens: string
  outputTokens: string
  thinkingOutputTokens?: string
  responseOutputTokens?: string
  apiProvider: string
  responseId?: string
}

type GeneratorMetadata = {
  stepIndices?: number[]
  chatModel?: {
    model: string
    usage: UsageEntry
    chatStartMetadata?: {
      createdAt?: string
    }
  }
}

type CachedCascade = {
  mtimeMs: number
  sizeBytes: number
  calls: ParsedProviderCall[]
}

type AntigravityCache = {
  version: number
  cascades: Record<string, CachedCascade>
}

let cachedServer: ServerInfo | null | undefined
let cachedModelMap: ModelMap | undefined
let memCache: AntigravityCache | null = null
let cacheDirty = false
let httpsAgent: https.Agent | undefined

function getAgent(): https.Agent {
  if (!httpsAgent) httpsAgent = new https.Agent({ rejectUnauthorized: false })
  return httpsAgent
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), 'antigravity-results.json')
}

async function loadCache(): Promise<AntigravityCache> {
  if (memCache) return memCache
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as AntigravityCache
    if (cache.version === CACHE_VERSION && cache.cascades && typeof cache.cascades === 'object') {
      memCache = cache
      return cache
    }
  } catch { /* no cache or invalid */ }
  memCache = { version: CACHE_VERSION, cascades: {} }
  return memCache
}

async function flushCache(liveCascadeIds?: Set<string>): Promise<void> {
  if (!memCache) return
  // If the caller supplied liveCascadeIds, we must run the eviction step
  // even when no cascade was added or updated this run; otherwise deleted
  // .pb files would persist in the cache forever once it stops getting
  // dirty writes. Mark the cache dirty when an eviction happens so the
  // file write below proceeds.
  if (liveCascadeIds) {
    for (const id of Object.keys(memCache.cascades)) {
      if (!liveCascadeIds.has(id)) {
        delete memCache.cascades[id]
        cacheDirty = true
      }
    }
  }
  if (!cacheDirty) return
  try {

    const dir = getCacheDir()
    await mkdir(dir, { recursive: true })
    const finalPath = getCachePath()
    const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(memCache), { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tempPath, finalPath)
    } catch {
      try { await unlink(tempPath) } catch { /* cleanup */ }
    }
    cacheDirty = false
  } catch { /* best-effort */ }
}

async function detectServer(): Promise<ServerInfo | null> {
  if (cachedServer !== undefined) return cachedServer
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-eo', 'args'], { encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })
    for (const line of output.split('\n')) {
      if (!line.includes('language_server') || !line.includes('antigravity')) continue
      if (!line.includes('--https_server_port')) continue

      const csrfMatch = line.match(/--csrf_token\s+([0-9a-f-]{32,})/)
      const portMatch = line.match(/--https_server_port\s+(\d+)/)
      if (csrfMatch && portMatch) {
        cachedServer = { csrfToken: csrfMatch[1]!, port: parseInt(portMatch[1]!, 10) }
        return cachedServer
      }
    }
  } catch { /* ps failed or timed out */ }
  cachedServer = null
  return null
}

async function rpc(server: ServerInfo, method: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': server.csrfToken,
        'Content-Length': Buffer.byteLength(data),
      },
      agent: getAgent(),
      timeout: RPC_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = []
      let totalBytes = 0
      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > MAX_RESPONSE_BYTES) {
          res.destroy()
          reject(new Error(`RPC ${method}: response too large`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`RPC ${method}: HTTP ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch {
          reject(new Error(`RPC ${method}: invalid JSON`))
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`RPC ${method}: timeout`)) })
    req.write(data)
    req.end()
  })
}

async function getModelMap(server: ServerInfo): Promise<ModelMap> {
  if (cachedModelMap) return cachedModelMap
  const map: ModelMap = {}
  try {
    const resp = await rpc(server, 'GetAvailableModels') as {
      response?: { models?: Record<string, { model?: string }> }
    }
    const models = resp?.response?.models
    if (models) {
      for (const [key, info] of Object.entries(models)) {
        if (info.model) map[info.model] = key
      }
    }
  } catch { /* best-effort */ }
  cachedModelMap = map
  return map
}

// Strip Antigravity-specific suffixes so the pricing DB can match
function normalizePricingModel(model: string): string {
  return model.replace(/-(high|low|agent)$/, '')
}

async function discoverSessions(): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let files: string[]
  try {
    files = await readdir(CONVERSATIONS_DIR)
  } catch {
    return sources
  }

  for (const file of files) {
    if (!file.endsWith('.pb')) continue
    sources.push({
      path: join(CONVERSATIONS_DIR, file),
      project: 'antigravity',
      provider: 'antigravity',
    })
  }
  return sources
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const cascadeId = basename(source.path, '.pb')
      const cache = await loadCache()

      const s = await stat(source.path).catch(() => null)
      if (!s) return

      const cached = cache.cascades[cascadeId]
      if (cached && cached.mtimeMs === s.mtimeMs && cached.sizeBytes === s.size) {
        for (const call of cached.calls) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const server = await detectServer()
      if (!server) {
        if (cached) {
          for (const call of cached.calls) {
            if (seenKeys.has(call.deduplicationKey)) continue
            seenKeys.add(call.deduplicationKey)
            yield call
          }
        }
        return
      }

      const modelMap = await getModelMap(server)

      let metadata: GeneratorMetadata[]
      try {
        const resp = await rpc(server, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId }) as {
          generatorMetadata?: GeneratorMetadata[]
        }
        metadata = resp?.generatorMetadata ?? []
      } catch {
        if (cached) {
          for (const call of cached.calls) {
            if (seenKeys.has(call.deduplicationKey)) continue
            seenKeys.add(call.deduplicationKey)
            yield call
          }
        }
        return
      }

      const results: ParsedProviderCall[] = []

      for (let i = 0; i < metadata.length; i++) {
        const entry = metadata[i]!
        const usage = entry.chatModel?.usage
        if (!usage) continue

        const inputTokens = parseInt(usage.inputTokens ?? '0', 10)
        const outputTokens = parseInt(usage.outputTokens ?? '0', 10)
        const thinkingTokens = parseInt(usage.thinkingOutputTokens ?? '0', 10)
        const responseTokens = parseInt(usage.responseOutputTokens ?? '0', 10)

        if (inputTokens === 0 && outputTokens === 0) continue

        const responseId = usage.responseId || String(i)
        const dedupKey = `antigravity:${cascadeId}:${responseId}`

        const model = modelMap[usage.model] ?? usage.model
        const pricingModel = normalizePricingModel(model)
        const timestamp = entry.chatModel?.chatStartMetadata?.createdAt ?? ''
        const costUSD = calculateCost(pricingModel, inputTokens, responseTokens + thinkingTokens, 0, 0, 0)

        results.push({
          provider: 'antigravity',
          model,
          inputTokens,
          outputTokens: responseTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: thinkingTokens,
          webSearchRequests: 0,
          costUSD,
          tools: [],
          bashCommands: [],
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: '',
          sessionId: cascadeId,
        })
      }

      cache.cascades[cascadeId] = {
        mtimeMs: s.mtimeMs,
        sizeBytes: s.size,
        calls: results,
      }
      cacheDirty = true

      for (const call of results) {
        if (seenKeys.has(call.deduplicationKey)) continue
        seenKeys.add(call.deduplicationKey)
        yield call
      }
    },
  }
}

const modelDisplayNames: Record<string, string> = {
  'gemini-3-pro': 'Gemini 3 Pro',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3-flash-agent': 'Gemini 3 Flash',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'claude-opus-4-6-thinking': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

export function createAntigravityProvider(): Provider {
  return {
    name: 'antigravity',
    displayName: 'Antigravity',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions()
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export async function flushAntigravityCache(liveCascadeIds?: Set<string>): Promise<void> {
  await flushCache(liveCascadeIds)
}

export const antigravity = createAntigravityProvider()
