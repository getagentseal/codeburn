import { readdir, readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import https from 'https'

import { calculateCost } from '../models.js'
import { isSqliteAvailable, isSqliteBusyError, openDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

type AntigravityConversationRoot = {
  dir: string
  project: string
  extensions: readonly string[]
}

// Computed on each call rather than frozen at module load so discovery honors
// the current home directory (env overrides in tests, and any runtime change).
function conversationRoots(): readonly AntigravityConversationRoot[] {
  const home = homedir()
  return [
    {
      dir: join(home, '.gemini', 'antigravity', 'conversations'),
      project: 'antigravity',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-cli', 'conversations'),
      project: 'antigravity-cli',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-cli', 'implicit'),
      project: 'antigravity-cli',
      extensions: ['.pb'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-ide', 'conversations'),
      project: 'antigravity-ide',
      extensions: ['.pb', '.db'],
    },
    {
      dir: join(home, '.gemini', 'antigravity-ide', 'implicit'),
      project: 'antigravity-ide',
      extensions: ['.pb'],
    },
  ]
}
const CACHE_VERSION = 5

const RPC_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export type ServerInfo = {
  port: number
  csrfToken: string
}

type ServerCandidate = ServerInfo & {
  appDataDir?: 'antigravity' | 'antigravity-cli' | 'antigravity-ide'
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

export type GeneratorMetadata = {
  stepIndices?: number[]
  chatModel?: {
    model: string
    usage: UsageEntry
    chatStartMetadata?: {
      createdAt?: string
    }
  }
}

type ModelMapResponse = {
  models?: Record<string, { model?: string; displayName?: string }>
  response?: {
    models?: Record<string, { model?: string; displayName?: string }>
  }
}

type GeneratorMetadataResponse = {
  generatorMetadata?: GeneratorMetadata[]
  response?: {
    generatorMetadata?: GeneratorMetadata[]
  }
}

type StatusLineCurrentUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type StatusLinePayload = {
  conversation_id?: string
  session_id?: string
  model?: string | {
    id?: string
    display_name?: string
  }
  context_window?: {
    current_usage?: StatusLineCurrentUsage | null
  }
}

type StatusLineEvent = {
  at: string
  conversationId: string
  sessionId?: string
  model: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
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

type ProtoField = {
  number: number
  wireType: number
  value?: bigint
  bytes?: Uint8Array
}

type ProtoVarint = {
  value: bigint
  offset: number
}

type AntigravityGenMetadataRow = {
  idx: number
  data: Uint8Array | string
}

const cachedServers = new Map<string, ServerInfo | null>()
const cachedModelMaps = new Map<string, ModelMap>()
let memCache: AntigravityCache | null = null
let cacheDirty = false
let httpsAgent: https.Agent | undefined
const protoTextDecoder = new TextDecoder('utf-8', { fatal: false })

const SERVER_PORT_FLAGS = ['https_server_port', 'extension_server_port', 'https-server-port', 'extension-server-port']
const CSRF_TOKEN_FLAGS = ['csrf_token', 'extension_server_csrf_token', 'csrf-token', 'extension-server-csrf-token']
const APP_DATA_DIR_FLAGS = ['app_data_dir', 'app-data-dir']

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

export function getAntigravityStatusLineEventsPath(): string {
  return join(getCacheDir(), 'antigravity-statusline.jsonl')
}

function execFileText(command: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function getFlagValue(line: string, names: string[]): string | null {
  for (const name of names) {
    const match = line.match(new RegExp(`--${name}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, 'i'))
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value && !value.startsWith('--')) return value
  }
  return null
}

function isLikelyCsrfToken(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9._~:/+=-]+$/.test(value)
}

function normalizeAppDataDir(value: string | null): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('antigravity-ide')) return 'antigravity-ide'
  if (normalized.includes('antigravity-cli')) return 'antigravity-cli'
  if (normalized.includes('antigravity')) return 'antigravity'
  return undefined
}

export function extractAntigravityAppDataDirFromLine(line: string): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' | undefined {
  return normalizeAppDataDir(getFlagValue(line, APP_DATA_DIR_FLAGS))
}

function parseAntigravityServerCandidateFromLine(line: string): ServerCandidate | null {
  const lower = line.toLowerCase()
  if (!lower.includes('language_server') || !lower.includes('antigravity')) return null

  const rawPort = getFlagValue(line, SERVER_PORT_FLAGS)
  const csrfToken = getFlagValue(line, CSRF_TOKEN_FLAGS)
  if (!rawPort || !csrfToken) return null
  if (!isLikelyCsrfToken(csrfToken)) return null

  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null

  return {
    port,
    csrfToken,
    appDataDir: extractAntigravityAppDataDirFromLine(line),
  }
}

export function parseAntigravityServerInfoFromLine(line: string): ServerInfo | { port: 0; csrfToken: string } | null {
  const candidate = parseAntigravityServerCandidateFromLine(line)
  return candidate ? { port: candidate.port, csrfToken: candidate.csrfToken } : null
}

export function parseAntigravityServerInfo(lines: string[]): ServerInfo | null {
  for (const line of lines) {
    const server = parseAntigravityServerInfoFromLine(line)
    if (server) return server
  }
  return null
}

function parseAntigravityServerCandidates(lines: string[]): ServerCandidate[] {
  return lines
    .map(parseAntigravityServerCandidateFromLine)
    .filter((server): server is ServerCandidate => server !== null)
}

function getCanonicalModelId(key: string, displayName?: string): string {
  if (displayName) {
    const lower = displayName.toLowerCase()
    if (lower.includes('3.5 flash')) {
      if (lower.includes('high')) return 'gemini-3.5-flash-high'
      if (lower.includes('medium')) return 'gemini-3.5-flash-medium'
      if (lower.includes('low')) return 'gemini-3.5-flash-low'
      return 'gemini-3.5-flash'
    }
    if (lower.includes('3.1 pro')) {
      if (lower.includes('high')) return 'gemini-3.1-pro-high'
      if (lower.includes('low')) return 'gemini-3.1-pro-low'
      return 'gemini-3.1-pro'
    }
    if (lower.includes('3.1 flash')) {
      if (lower.includes('image')) return 'gemini-3.1-flash-image'
      if (lower.includes('lite')) return 'gemini-3.1-flash-lite'
      return 'gemini-3.1-flash'
    }
    if (lower.includes('3 flash')) {
      return 'gemini-3-flash'
    }
    if (lower.includes('3 pro')) {
      return 'gemini-3-pro'
    }
  }
  return key
}

export function extractAntigravityModelMap(resp: unknown): ModelMap {
  if (!resp || typeof resp !== 'object') return {}
  const data = resp as ModelMapResponse
  const models = data.response?.models ?? data.models
  const map = new Map<string, string>()
  if (!models) return {}
  for (const [key, info] of Object.entries(models)) {
    if (info && typeof info === 'object' && typeof info.model === 'string') {
      const canonicalKey = getCanonicalModelId(key, info.displayName)
      map.set(info.model, canonicalKey)
    }
  }
  return Object.fromEntries(map)
}

export function extractAntigravityGeneratorMetadata(resp: unknown): GeneratorMetadata[] {
  if (!resp || typeof resp !== 'object') return []
  const data = resp as GeneratorMetadataResponse
  const metadata = data.response?.generatorMetadata ?? data.generatorMetadata
  return Array.isArray(metadata) ? metadata : []
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

async function readProcessCommandLines(): Promise<string[]> {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*' } | ForEach-Object { $_.CommandLine }",
    ].join('; ')
    const output = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 5000)
    return output.split(/\r?\n/)
  }

  const output = await execFileText('ps', ['-ww', '-eo', 'args'])
  return output.split('\n')
}

async function resolveEphemeralPort(csrfToken: string, appDataDir?: 'antigravity' | 'antigravity-cli' | 'antigravity-ide'): Promise<ServerInfo | null> {
  if (process.platform === 'win32') {
    try {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*' } | ForEach-Object { @{ PID = $_.ProcessId; Cmd = $_.CommandLine } | ConvertTo-Json -Compress }"
      ].join('; ')
      const output = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 5000)
      
      let targetPid = 0
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const proc = JSON.parse(line) as { PID: number; Cmd: string }
          const candidate = parseAntigravityServerCandidateFromLine(proc.Cmd)
          if (candidate && candidate.csrfToken === csrfToken) {
            if (!appDataDir || !candidate.appDataDir || candidate.appDataDir === appDataDir) {
              targetPid = proc.PID
              break
            }
          }
        } catch { /* skip invalid parse */ }
      }
      
      if (targetPid === 0) return null
      
      const portScript = `Get-NetTCPConnection -State Listen -OwningProcess ${targetPid} | Select-Object -ExpandProperty LocalPort`
      const portOutput = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', portScript], 5000)
      const ports = portOutput.split(/\r?\n/)
        .map(p => Number(p.trim()))
        .filter(p => Number.isInteger(p) && p > 0)
      
      for (const port of ports) {
        try {
          await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: '127.0.0.1',
              port: port,
              path: '/exa.language_server_pb.LanguageServerService/GetAvailableModels',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
                'Content-Length': 2,
              },
              agent: getAgent(),
              timeout: 1000,
            }, (res) => {
              if (res.statusCode === 200) resolve(true)
              else reject(new Error())
            })
            req.on('error', reject)
            req.write('{}')
            req.end()
          })
          return { port, csrfToken }
        } catch { /* try next port */ }
      }
    } catch { /* best-effort */ }
    return null
  }

  try {
    const processOutput = await execFileText('ps', ['-ww', '-eo', 'pid=,args='])
    let pid = ''
    for (const line of processOutput.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const candidate = parseAntigravityServerCandidateFromLine(match[2]!)
      if (!candidate) continue
      if (candidate.csrfToken !== csrfToken) continue
      if (appDataDir && candidate.appDataDir && candidate.appDataDir !== appDataDir) continue
      pid = match[1]!
      break
    }
    if (!pid) return null
    const lsofOutput = await execFileText('lsof', ['-a', '-i', '-P', '-n', '-p', pid])
    for (const line of lsofOutput.split('\n')) {
      if (!line.includes('LISTEN')) continue
      const match = line.match(/:(\d+)\s+\(LISTEN\)/)
      if (match) {
        const port = Number(match[1])
        if (port > 0) return { port, csrfToken }
      }
    }
  } catch { /* best-effort */ }
  return null
}

export function antigravityAppDataDirFromSourcePath(path: string): 'antigravity' | 'antigravity-cli' | 'antigravity-ide' {
  const lower = path.replace(/\\/g, '/').toLowerCase()
  if (lower.includes('/.gemini/antigravity-ide/')) return 'antigravity-ide'
  if (lower.includes('/.gemini/antigravity-cli/')) return 'antigravity-cli'
  return 'antigravity'
}

async function detectServer(appDataDir: 'antigravity' | 'antigravity-cli' | 'antigravity-ide' = 'antigravity'): Promise<ServerInfo | null> {
  if (cachedServers.has(appDataDir)) return cachedServers.get(appDataDir)!
  try {
    const candidates = parseAntigravityServerCandidates(await readProcessCommandLines())
    const info = candidates.find(candidate => candidate.appDataDir === appDataDir)
      ?? (appDataDir === 'antigravity' ? candidates.find(candidate => candidate.appDataDir === undefined) : undefined)
      ?? null
    if (info && info.port > 0 && appDataDir !== 'antigravity-ide') {
      cachedServers.set(appDataDir, { port: info.port, csrfToken: info.csrfToken })
    } else if (info) {
      cachedServers.set(appDataDir, await resolveEphemeralPort(info.csrfToken, appDataDir))
    } else {
      cachedServers.set(appDataDir, null)
    }
    return cachedServers.get(appDataDir)!
  } catch { /* process discovery failed or timed out */ }
  cachedServers.set(appDataDir, null)
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
  const cacheKey = `${server.port}:${server.csrfToken}`
  const cachedModelMap = cachedModelMaps.get(cacheKey)
  if (cachedModelMap) return cachedModelMap
  try {
    const modelMap = extractAntigravityModelMap(await rpc(server, 'GetAvailableModels'))
    cachedModelMaps.set(cacheKey, modelMap)
    return modelMap
  } catch { /* best-effort */ }
  cachedModelMaps.set(cacheKey, {})
  return {}
}

// Strip Antigravity-specific suffixes so the pricing DB can match
const PRICING_ALIASES: Record<string, string> = {
  'gemini-pro': 'gemini-3.1-pro',
}

function normalizePricingModel(model: string): string {
  const stripped = model.replace(/-(high|medium|low|agent)$/, '')
  return PRICING_ALIASES[stripped] ?? stripped
}

function readProtoVarint(data: Uint8Array, startOffset: number): ProtoVarint | null {
  let value = 0n
  let shift = 0n
  let offset = startOffset

  while (offset < data.length) {
    const byte = BigInt(data[offset]!)
    offset += 1
    value |= (byte & 0x7fn) << shift
    if ((byte & 0x80n) === 0n) return { value, offset }
    shift += 7n
    if (shift > 70n) return null
  }

  return null
}

function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0

  while (offset < data.length) {
    const key = readProtoVarint(data, offset)
    if (!key) break
    offset = key.offset

    const fieldNumber = Number(key.value >> 3n)
    const wireType = Number(key.value & 0x7n)
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) break

    if (wireType === 0) {
      const value = readProtoVarint(data, offset)
      if (!value) break
      fields.push({ number: fieldNumber, wireType, value: value.value })
      offset = value.offset
      continue
    }

    if (wireType === 1) {
      if (offset + 8 > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 8) })
      offset += 8
      continue
    }

    if (wireType === 2) {
      const length = readProtoVarint(data, offset)
      if (!length) break
      offset = length.offset
      const byteLength = Number(length.value)
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + byteLength) })
      offset += byteLength
      continue
    }

    if (wireType === 5) {
      if (offset + 4 > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 4) })
      offset += 4
      continue
    }

    break
  }

  return fields
}

function firstProtoField(fields: readonly ProtoField[], fieldNumber: number): ProtoField | undefined {
  return fields.find(field => field.number === fieldNumber)
}

function protoFieldText(field: ProtoField | undefined): string | undefined {
  if (!field?.bytes || field.bytes.length === 0) return undefined
  const text = protoTextDecoder.decode(field.bytes)
  if (!text || /[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(text)) return undefined
  return text
}

function protoFieldPositiveInteger(field: ProtoField | undefined): number {
  if (field?.value === undefined) return 0
  const value = Number(field.value)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function protoFieldBytes(field: ProtoField | undefined): Uint8Array | undefined {
  return field?.bytes
}

function isAntigravityResponseId(value: string): boolean {
  return /^[^\s]+$/.test(value)
}

function antigravitySqliteResponseId(usageFields: readonly ProtoField[], fallback: string): string {
  const responseId = protoFieldText(firstProtoField(usageFields, 11))
  return responseId && isAntigravityResponseId(responseId) ? responseId : fallback
}

function genMetadataDataBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value
}

function antigravitySqliteMetadataAttributes(chatFields: readonly ProtoField[]): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const field of chatFields) {
    if (field.number !== 20) continue
    const pairFields = parseProtoFields(protoFieldBytes(field) ?? new Uint8Array())
    const key = protoFieldText(firstProtoField(pairFields, 1))
    const value = protoFieldText(firstProtoField(pairFields, 2))
    if (key && value) attributes.set(key, value)
  }
  return attributes
}

function antigravitySqliteModel(chatFields: readonly ProtoField[]): string {
  const attributes = antigravitySqliteMetadataAttributes(chatFields)
  const displayName = protoFieldText(firstProtoField(chatFields, 21))
  const rawModel = protoFieldText(firstProtoField(chatFields, 19))
    ?? attributes.get('model_enum')
    ?? displayName
    ?? 'unknown'

  return getCanonicalModelId(rawModel, displayName)
}

// Decode a proto field that carries a time into an ISO-8601 string. Antigravity
// may encode ChatStartMetadata.created_at as an ISO string, a Timestamp
// submessage (seconds in field 1), or a bare unix varint. Returns '' when the
// field is absent or unparseable so the caller can fall back.
function protoTimestampToIso(field: ProtoField | undefined): string {
  if (!field) return ''
  const text = protoFieldText(field)
  if (text && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString()
  if (field.bytes) {
    // google.protobuf.Timestamp submessage: seconds (#1), nanos (#2).
    const tsFields = parseProtoFields(field.bytes)
    const seconds = firstProtoField(tsFields, 1)?.value
    if (seconds !== undefined) {
      const nanos = firstProtoField(tsFields, 2)?.value ?? 0n
      const ms = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6)
      if (Number.isSafeInteger(ms) && ms > 0) return new Date(ms).toISOString()
    }
  }
  if (field.value !== undefined) {
    const raw = Number(field.value)
    const ms = raw < 1e12 ? raw * 1000 : raw
    if (Number.isSafeInteger(ms) && ms > 0) return new Date(ms).toISOString()
  }
  return ''
}

// ChatStartMetadata lives at chatModel(#1).#9; its created_at is #4. Not every
// gen_metadata row carries it, so this returns '' when missing.
function antigravitySqliteCreatedAt(chatFields: readonly ProtoField[]): string {
  const metadataBytes = protoFieldBytes(firstProtoField(chatFields, 9))
  if (!metadataBytes) return ''
  return protoTimestampToIso(firstProtoField(parseProtoFields(metadataBytes), 4))
}

function buildCallFromSqliteGenMetadataRow(cascadeId: string, row: AntigravityGenMetadataRow): ParsedProviderCall | null {
  const rootFields = parseProtoFields(genMetadataDataBytes(row.data))
  const chatFields = parseProtoFields(protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array())
  const usageFields = parseProtoFields(protoFieldBytes(firstProtoField(chatFields, 4)) ?? new Uint8Array())
  if (usageFields.length === 0) return null

  const inputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 2))
    || protoFieldPositiveInteger(firstProtoField(usageFields, 1))
  const totalOutputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 3))
  let responseTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 9))
  let thinkingTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 10))

  if (responseTokens === 0 && thinkingTokens === 0) {
    responseTokens = totalOutputTokens
  } else if (totalOutputTokens > 0 && responseTokens + thinkingTokens !== totalOutputTokens) {
    const adjustedResponseTokens = totalOutputTokens - thinkingTokens
    if (adjustedResponseTokens >= 0) responseTokens = adjustedResponseTokens
  }

  if (inputTokens === 0 && totalOutputTokens === 0) return null

  const responseId = antigravitySqliteResponseId(usageFields, String(row.idx))
  const model = antigravitySqliteModel(chatFields)
  const pricingModel = normalizePricingModel(model)
  const costUSD = calculateCost(pricingModel, inputTokens, responseTokens + thinkingTokens, 0, 0, 0)

  return {
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
    timestamp: antigravitySqliteCreatedAt(chatFields),
    speed: 'standard',
    deduplicationKey: `antigravity:${cascadeId}:${responseId}`,
    userMessage: '',
    sessionId: cascadeId,
  }
}

function buildCallsFromSqliteGenMetadata(cascadeId: string, rows: AntigravityGenMetadataRow[]): ParsedProviderCall[] {
  const calls: ParsedProviderCall[] = []
  const seenResponseIds = new Set<string>()

  for (const row of rows) {
    const call = buildCallFromSqliteGenMetadataRow(cascadeId, row)
    if (!call) continue
    if (seenResponseIds.has(call.deduplicationKey)) continue
    seenResponseIds.add(call.deduplicationKey)
    calls.push(call)
  }

  return calls
}

async function parseSqliteGenMetadataCalls(filePath: string, cascadeId: string): Promise<ParsedProviderCall[]> {
  if (!filePath.toLowerCase().endsWith('.db')) return []
  if (!isSqliteAvailable()) return []

  let db: ReturnType<typeof openDatabase> | null = null
  try {
    db = openDatabase(filePath)
    const rows = db.query<AntigravityGenMetadataRow>('SELECT idx, data FROM gen_metadata ORDER BY idx')
    return buildCallsFromSqliteGenMetadata(cascadeId, rows)
  } catch (err) {
    // Let a transient lock propagate so the run retries this file on the next
    // refresh instead of treating it as empty (see parser.ts busy handling).
    if (isSqliteBusyError(err)) throw err
    return []
  } finally {
    db?.close()
  }
}

function parseFiniteToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function usageSignature(event: StatusLineEvent): string {
  const u = event.usage
  return [
    event.model,
    u.inputTokens,
    u.outputTokens,
    u.cacheCreationInputTokens,
    u.cacheReadInputTokens,
  ].join(':')
}

function usageHasTokens(usage: StatusLineEvent['usage']): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheCreationInputTokens > 0 ||
    usage.cacheReadInputTokens > 0
  )
}

function usageIsMonotonic(current: StatusLineEvent['usage'], previous: StatusLineEvent['usage']): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.cacheCreationInputTokens >= previous.cacheCreationInputTokens &&
    current.cacheReadInputTokens >= previous.cacheReadInputTokens
  )
}

function usageDelta(current: StatusLineEvent['usage'], previous: StatusLineEvent['usage']): StatusLineEvent['usage'] {
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens - previous.cacheCreationInputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens - previous.cacheReadInputTokens,
  }
}

export function antigravityCascadeIdFromPath(path: string): string {
  return basename(path).replace(/\.(pb|db)$/i, '')
}

function buildCallsFromGeneratorMetadata(
  cascadeId: string,
  metadata: GeneratorMetadata[],
  modelMap: ModelMap,
): ParsedProviderCall[] {
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

  return results
}

function isConversationFile(file: string, extensions: readonly string[]): boolean {
  const lowerFile = file.toLowerCase()
  return extensions.some(ext => lowerFile.endsWith(ext))
}

export function isAntigravityStatusLineEventsPath(path: string): boolean {
  return path === getAntigravityStatusLineEventsPath()
}

export async function discoverAntigravitySessionSources(
  roots?: readonly AntigravityConversationRoot[],
): Promise<SessionSource[]> {
  // The statusline JSONL is a synthetic source only appended for the real
  // default roots, not when a caller passes an explicit (test) root set.
  const includeStatusLineEvents = roots === undefined
  const effectiveRoots = roots ?? conversationRoots()
  const sources: SessionSource[] = []
  for (const root of effectiveRoots) {
    let files: string[]
    try {
      files = await readdir(root.dir)
    } catch {
      continue
    }

    for (const file of files.sort()) {
      if (!isConversationFile(file, root.extensions)) continue
      const path = join(root.dir, file)
      const s = await stat(path).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({
        path,
        project: root.project,
        provider: 'antigravity',
      })
    }
  }

  if (includeStatusLineEvents) {
    const statusLinePath = getAntigravityStatusLineEventsPath()
    const statusLineStat = await stat(statusLinePath).catch(() => null)
    if (statusLineStat?.isFile()) {
      sources.push({
        path: statusLinePath,
        project: 'antigravity-cli',
        provider: 'antigravity',
      })
    }
  }

  return sources
}

function parseStatusLinePayload(input: unknown): StatusLineEvent | null {
  if (!input || typeof input !== 'object') return null
  const payload = input as StatusLinePayload
  if (typeof payload.conversation_id !== 'string' || payload.conversation_id.length === 0) return null
  const usage = payload.context_window?.current_usage
  if (!usage) return null

  const event: StatusLineEvent = {
    at: new Date().toISOString(),
    conversationId: payload.conversation_id,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    model: typeof payload.model === 'string'
      ? payload.model
      : payload.model?.id ?? payload.model?.display_name ?? 'unknown',
    usage: {
      inputTokens: parseFiniteToken(usage.input_tokens),
      outputTokens: parseFiniteToken(usage.output_tokens),
      cacheCreationInputTokens: parseFiniteToken(usage.cache_creation_input_tokens),
      cacheReadInputTokens: parseFiniteToken(usage.cache_read_input_tokens),
    },
  }

  const u = event.usage
  if (u.inputTokens === 0 && u.outputTokens === 0 && u.cacheCreationInputTokens === 0 && u.cacheReadInputTokens === 0) {
    return null
  }
  if (event.model === 'unknown') return null
  return event
}

export async function recordAntigravityStatusLinePayload(input: unknown): Promise<boolean> {
  const event = parseStatusLinePayload(input)
  if (!event) return false

  const path = getAntigravityStatusLineEventsPath()
  await mkdir(getCacheDir(), { recursive: true, mode: 0o700 })
  const fd = await open(path, 'a', 0o600)
  try {
    await fd.appendFile(`${JSON.stringify(event)}\n`, { encoding: 'utf-8' })
  } finally {
    await fd.close()
  }
  return true
}

function parseStatusLineEvent(input: unknown): StatusLineEvent | null {
  if (!input || typeof input !== 'object') return null
  const event = input as StatusLineEvent
  if (typeof event.at !== 'string' || Number.isNaN(new Date(event.at).getTime())) return null
  if (typeof event.conversationId !== 'string' || event.conversationId.length === 0) return null
  if (typeof event.model !== 'string' || event.model.length === 0) return null
  if (!event.usage || typeof event.usage !== 'object') return null

  const usage = {
    inputTokens: parseFiniteToken(event.usage.inputTokens),
    outputTokens: parseFiniteToken(event.usage.outputTokens),
    cacheCreationInputTokens: parseFiniteToken(event.usage.cacheCreationInputTokens),
    cacheReadInputTokens: parseFiniteToken(event.usage.cacheReadInputTokens),
  }

  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheCreationInputTokens === 0 &&
    usage.cacheReadInputTokens === 0
  ) return null

  return {
    at: event.at,
    conversationId: event.conversationId,
    sessionId: typeof event.sessionId === 'string' ? event.sessionId : undefined,
    model: event.model,
    usage,
  }
}

function hasRpcCacheForConversation(seenKeys: Set<string>, conversationId: string): boolean {
  const prefix = `antigravity:${conversationId}:`
  for (const key of seenKeys) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

async function parseStatusLineCalls(source: SessionSource, seenKeys: Set<string>): Promise<ParsedProviderCall[]> {
  const raw = await readFile(source.path, 'utf-8').catch(() => '')
  const runsByConversation = new Map<string, Array<{ event: StatusLineEvent; signature: string; count: number }>>()

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const event = parseStatusLineEvent(parsed)
    if (!event) continue
    if (hasRpcCacheForConversation(seenKeys, event.conversationId)) continue

    const signature = usageSignature(event)
    const runs = runsByConversation.get(event.conversationId) ?? []
    const lastRun = runs.at(-1)
    if (lastRun?.signature === signature) {
      lastRun.count += 1
      lastRun.event = event
    } else {
      runs.push({ event, signature, count: 1 })
      runsByConversation.set(event.conversationId, runs)
    }
  }

  const results: ParsedProviderCall[] = []

  for (const runs of runsByConversation.values()) {
    let turnIndex = 0
    let previousSnapshotUsage: StatusLineEvent['usage'] | null = null
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!
      const isLastRun = i === runs.length - 1
      if (run.count === 1 && !isLastRun) continue

      const event = run.event
      const signature = run.signature
      const billableUsage = previousSnapshotUsage && usageIsMonotonic(event.usage, previousSnapshotUsage)
        ? usageDelta(event.usage, previousSnapshotUsage)
        : event.usage
      previousSnapshotUsage = event.usage
      if (!usageHasTokens(billableUsage)) continue

      const dedupKey = `antigravity-statusline:${event.conversationId}:${turnIndex}:${signature}`
      turnIndex += 1
      if (seenKeys.has(dedupKey)) continue

      const u = billableUsage
      const costUSD = calculateCost(
        normalizePricingModel(event.model),
        u.inputTokens,
        u.outputTokens,
        u.cacheCreationInputTokens,
        u.cacheReadInputTokens,
        0,
      )

      results.push({
        provider: 'antigravity',
        model: event.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheCreationInputTokens: u.cacheCreationInputTokens,
        cacheReadInputTokens: u.cacheReadInputTokens,
        cachedInputTokens: 0,
        // StatusLine current_usage exposes aggregate output tokens, not a
        // separate thinking/response split. Preserve the exact total instead
        // of inventing a breakdown.
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD,
        tools: [],
        bashCommands: [],
        timestamp: event.at,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: '',
        sessionId: event.conversationId,
        project: source.project,
      })
    }
  }

  return results
}

export function shouldReparseAntigravitySource(path: string, cachedTurnCount: number): boolean {
  if (cachedTurnCount === 0) return true
  return isAntigravityStatusLineEventsPath(path)
}

async function findCascadeSource(cascadeId: string): Promise<SessionSource | null> {
  const sources = await discoverAntigravitySessionSources()
  return sources.find(source => {
    const lower = source.path.replace(/\\/g, '/').toLowerCase()
    return (lower.includes('/.gemini/antigravity-cli/') || lower.includes('/.gemini/antigravity-ide/')) &&
      antigravityCascadeIdFromPath(source.path) === cascadeId
  }) ?? null
}

export async function snapshotAntigravityStatusLinePayload(input: unknown): Promise<boolean> {
  const event = parseStatusLinePayload(input)
  if (!event) return false

  const cascadeId = event.conversationId
  const source = await findCascadeSource(cascadeId)
  if (!source) return false

  const s = await stat(source.path).catch(() => null)
  if (!s) return false

  const cache = await loadCache()
  const cached = cache.cascades[cascadeId]
  if (cached && cached.mtimeMs === s.mtimeMs && cached.sizeBytes === s.size && cached.calls.length > 0) {
    return true
  }

  const server = await detectServer(antigravityAppDataDirFromSourcePath(source.path))
  if (!server) return false

  let metadata: GeneratorMetadata[]
  try {
    const modelMap = await getModelMap(server)
    metadata = extractAntigravityGeneratorMetadata(
      await rpc(server, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId }),
    )
    const snapshotCalls = buildCallsFromGeneratorMetadata(cascadeId, metadata, modelMap)
    assignStableTimestamps(snapshotCalls, cached?.calls, new Date(s.mtimeMs).toISOString())
    cache.cascades[cascadeId] = {
      mtimeMs: s.mtimeMs,
      sizeBytes: s.size,
      calls: snapshotCalls,
    }
    cacheDirty = true
    await flushCache()
    return cache.cascades[cascadeId]!.calls.length > 0
  } catch {
    return false
  }
}

async function extractWorkspacePath(filePath: string): Promise<string | undefined> {
  let text = ''
  if (filePath.endsWith('.db') && isSqliteAvailable()) {
    try {
      const db = openDatabase(filePath)
      const rows = db.query<{ data: Uint8Array }>('SELECT data FROM trajectory_metadata_blob')
      db.close()
      const textDecoder = new TextDecoder('utf-8', { fatal: false })
      text = rows.map(r => textDecoder.decode(r.data)).join(' ')
    } catch { /* ignore and fallback */ }
  }

  if (!text) {
    try {
      text = await readFile(filePath, 'utf-8')
    } catch {
      return undefined
    }
  }

  const match = text.match(/file:\/\/\/[^\x00-\x1F\x7F"'\s]+/i)
  if (!match) return undefined

  try {
    return fileURLToPath(match[0])
  } catch {
    return undefined
  }
}

function sanitizeProject(path: string): string {
  return basename(path.replace(/\\/g, '/'))
}

function applyAntigravityProject(call: ParsedProviderCall, source: SessionSource, projectPath: string | undefined): void {
  if (source.project === 'antigravity-cli') {
    call.project = source.project
    delete call.projectPath
    return
  }

  if (projectPath) {
    call.projectPath = projectPath
    call.project = sanitizeProject(projectPath)
    return
  }

  call.project = source.project
}

// gen_metadata rows and RPC entries without a real ChatStartMetadata.created_at
// carry no per-call timestamp. Left empty, those calls are dropped by the
// date-range filters in parser.ts (`if (!callTs) continue`), so each needs a
// fallback. The fallback must be *stable* across file rewrites: the generic
// session-cache persists whatever timestamp is emitted, and a non-durable
// source is cleared and reparsed whenever its mtime changes, so stamping the
// current mtime on every reparse would retro-date the whole session forward.
//
// assignStableTimestamps carries forward the timestamp already recorded for a
// dedup key (its first-seen time, held in the durable Antigravity cache) and
// only falls back to the current file mtime for genuinely new calls. Real
// timestamps (created_at) are preserved untouched. This runs on the fresh-parse
// paths whose result is written back to the cache.
function assignStableTimestamps(
  calls: ParsedProviderCall[],
  priorCalls: readonly ParsedProviderCall[] | undefined,
  firstSeenTimestamp: string,
): void {
  const priorByKey = new Map<string, string>()
  for (const prior of priorCalls ?? []) {
    if (prior.timestamp) priorByKey.set(prior.deduplicationKey, prior.timestamp)
  }
  for (const call of calls) {
    if (call.timestamp) continue
    call.timestamp = priorByKey.get(call.deduplicationKey) ?? firstSeenTimestamp
  }
}

// Emit-time safety net for cache-hit / cached-fallback paths, where the calls
// already carry stable timestamps from a prior parse. Applied to a copy so the
// cache is never mutated; only fills a still-empty timestamp defensively.
function withFallbackTimestamp(call: ParsedProviderCall, fallbackTimestamp: string): ParsedProviderCall {
  return call.timestamp ? call : { ...call, timestamp: fallbackTimestamp }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (isAntigravityStatusLineEventsPath(source.path)) {
        for (const call of await parseStatusLineCalls(source, seenKeys)) {
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const cascadeId = antigravityCascadeIdFromPath(source.path)
      const cache = await loadCache()

      const s = await stat(source.path).catch(() => null)
      if (!s) return

      const projectPath = await extractWorkspacePath(source.path)
      const fallbackTimestamp = new Date(s.mtimeMs).toISOString()

      const cached = cache.cascades[cascadeId]
      if (cached && cached.mtimeMs === s.mtimeMs && cached.sizeBytes === s.size && cached.calls.length > 0) {
        for (const call of cached.calls) {
          applyAntigravityProject(call, source, projectPath)
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield withFallbackTimestamp(call, fallbackTimestamp)
        }
        return
      }

      const sqliteResults = await parseSqliteGenMetadataCalls(source.path, cascadeId)
      if (sqliteResults.length > 0) {
        assignStableTimestamps(sqliteResults, cached?.calls, fallbackTimestamp)
        for (const call of sqliteResults) {
          applyAntigravityProject(call, source, projectPath)
        }

        cache.cascades[cascadeId] = {
          mtimeMs: s.mtimeMs,
          sizeBytes: s.size,
          calls: sqliteResults,
        }
        cacheDirty = true

        for (const call of sqliteResults) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const server = await detectServer(antigravityAppDataDirFromSourcePath(source.path))
      if (!server) {
        if (cached) {
          for (const call of cached.calls) {
            applyAntigravityProject(call, source, projectPath)
            if (seenKeys.has(call.deduplicationKey)) continue
            seenKeys.add(call.deduplicationKey)
            yield withFallbackTimestamp(call, fallbackTimestamp)
          }
        }
        return
      }

      const modelMap = await getModelMap(server)

      let metadata: GeneratorMetadata[]
      try {
        metadata = extractAntigravityGeneratorMetadata(
          await rpc(server, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId }),
        )
      } catch {
        if (cached) {
          for (const call of cached.calls) {
            applyAntigravityProject(call, source, projectPath)
            if (seenKeys.has(call.deduplicationKey)) continue
            seenKeys.add(call.deduplicationKey)
            yield withFallbackTimestamp(call, fallbackTimestamp)
          }
        }
        return
      }

      const results = buildCallsFromGeneratorMetadata(cascadeId, metadata, modelMap)
      assignStableTimestamps(results, cached?.calls, fallbackTimestamp)
      for (const call of results) {
        applyAntigravityProject(call, source, projectPath)
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
  'gemini-pro-agent': 'Gemini Pro',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3-flash-agent': 'Gemini 3 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (High)': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (Medium)': 'Gemini 3.5 Flash',
  'Gemini 3.5 Flash (Low)': 'Gemini 3.5 Flash',
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
      return discoverAntigravitySessionSources()
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
