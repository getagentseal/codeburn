import { readdir, readFile, stat } from 'fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'path'
import { homedir } from 'os'

import { readSessionLines } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'

type JsonObject = Record<string, unknown>

type LingTaiAgentManifest = {
  agent_id?: string
  agent_name?: string
  address?: string
  nickname?: string | null
  llm?: {
    model?: string
    base_url?: string
  }
}

type LingTaiLedgerEntry = {
  source?: string
  em_id?: string
  run_id?: string
  ts?: string | number
  input?: number | string
  output?: number | string
  thinking?: number | string
  cached?: number | string
  model?: string
  endpoint?: string
}

type LingTaiProviderOptions = {
  lingtaiHomeOverride?: string
  defaultHomeOverride?: string
  globalDirOverride?: string
  cwdOverride?: string
}

type LingTaiHome = {
  path: string
  projectPrefix?: string
}

function normalizeOptions(options?: string | LingTaiProviderOptions): LingTaiProviderOptions {
  return typeof options === 'string'
    ? { lingtaiHomeOverride: options }
    : options ?? {}
}

function expandHome(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

function splitPathList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(delimiter)
    .map(p => p.trim())
    .filter(Boolean)
}

async function existingDir(path: string): Promise<string | null> {
  const resolved = resolve(expandHome(path))
  const s = await stat(resolved).catch(() => null)
  return s?.isDirectory() ? resolved : null
}

function getDefaultLingTaiHome(options: LingTaiProviderOptions): string {
  return options.defaultHomeOverride ?? join(homedir(), '.lingtai')
}

function getLingTaiGlobalDir(options: LingTaiProviderOptions): string {
  return options.globalDirOverride
    ?? process.env['LINGTAI_TUI_GLOBAL_DIR']
    ?? join(homedir(), '.lingtai-tui')
}

function projectPrefixFromHome(lingtaiHome: string, defaultLingTaiHome: string): string | undefined {
  const defaultHome = resolve(expandHome(defaultLingTaiHome))
  const resolved = resolve(lingtaiHome)
  if (resolved === defaultHome) return undefined

  const projectName = basename(dirname(resolved))
  return projectName && projectName !== '.' ? sanitizeProject(projectName) : undefined
}

async function readRegisteredProjectPaths(globalDir: string): Promise<string[]> {
  const projects: string[] = []

  const registryRaw = await readFile(join(globalDir, 'registry.jsonl'), 'utf-8').catch(() => '')
  for (const line of registryRaw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const obj = asObject(JSON.parse(line))
      const path = stringField(obj, 'path')
      if (path) projects.push(path)
    } catch {
      // Ignore corrupt registry rows; LingTai treats this as append-only state.
    }
  }

  const briefDir = join(globalDir, 'brief', 'projects')
  const entries = await readdir(briefDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = await readJson<JsonObject>(join(briefDir, entry.name, 'meta.json'))
    const path = stringField(meta, 'project_path')
    if (path) projects.push(path)
  }

  return projects
}

function cwdLingTaiHomes(cwd: string): string[] {
  const homes: string[] = []
  let current = resolve(cwd)
  for (;;) {
    homes.push(join(current, '.lingtai'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return homes
}

async function getLingTaiHomes(options: LingTaiProviderOptions): Promise<LingTaiHome[]> {
  const explicit = splitPathList(options.lingtaiHomeOverride ?? process.env['LINGTAI_HOME'] ?? process.env['LINGTAI_TUI_HOME'])
  const defaultHome = getDefaultLingTaiHome(options)
  const candidates = explicit.length
    ? explicit
    : [
        defaultHome,
        ...(await readRegisteredProjectPaths(getLingTaiGlobalDir(options))).map(project => join(project, '.lingtai')),
        ...cwdLingTaiHomes(options.cwdOverride ?? process.cwd()),
      ]

  const seen = new Set<string>()
  const homes: LingTaiHome[] = []
  for (const candidate of candidates) {
    const path = await existingDir(candidate)
    if (!path || seen.has(path)) continue
    seen.add(path)
    homes.push({ path, projectPrefix: explicit.length ? undefined : projectPrefixFromHome(path, defaultHome) })
  }

  return homes
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'lingtai'
  return trimmed.replace(/^[/\\]+/, '').replace(/[:/\\]/g, '-')
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function stringField(obj: JsonObject | null, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numericField(obj: JsonObject, key: keyof LingTaiLedgerEntry): number {
  const raw = obj[key]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.trunc(n)
}

async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readFile(path, 'utf-8').catch(() => null)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readAgentManifest(agentDir: string): Promise<LingTaiAgentManifest | null> {
  return readJson<LingTaiAgentManifest>(join(agentDir, '.agent.json'))
}

function agentDirFromLedgerPath(ledgerPath: string): string {
  return dirname(dirname(ledgerPath))
}

function projectFromManifest(manifest: LingTaiAgentManifest | null, fallback: string, prefix?: string): string {
  const name = sanitizeProject(
    manifest?.nickname
      ?? manifest?.agent_name
      ?? manifest?.address
      ?? fallback,
  )
  return prefix ? `${prefix}-${name}` : name
}

function parseTimestamp(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    return new Date(ms).toISOString()
  }
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function parseLedgerLine(line: string | Buffer): LingTaiLedgerEntry | null {
  const text = Buffer.isBuffer(line) ? line.toString('utf-8') : line
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text) as unknown
    const obj = asObject(parsed)
    return obj ? obj as LingTaiLedgerEntry : null
  } catch {
    return null
  }
}

function activityForSource(sourceLabel: string): { userMessage: string; tools: string[]; subagentTypes: string[] } {
  const normalized = sourceLabel.trim().toLowerCase()

  if (normalized === 'tc_wake' || normalized.startsWith('tc_') || normalized.includes('wake')) {
    return {
      userMessage: 'LingTai task coordinator wake',
      tools: ['Agent'],
      subagentTypes: ['lingtai-task-coordinator'],
    }
  }

  if (normalized === 'daemon') {
    return {
      userMessage: 'LingTai daemon task',
      tools: ['Agent'],
      subagentTypes: ['lingtai-daemon'],
    }
  }

  if (normalized === 'summarize_apriori' || normalized.includes('summar')) {
    return {
      userMessage: 'LingTai planning summary',
      tools: ['EnterPlanMode'],
      subagentTypes: [],
    }
  }

  return {
    userMessage: normalized === 'main'
      ? 'LingTai main conversation'
      : `LingTai ${sourceLabel || 'main'} conversation`,
    tools: [],
    subagentTypes: [],
  }
}

async function discoverLedgersInHome(home: LingTaiHome): Promise<SessionSource[]> {
  const entries = await readdir(home.path, { withFileTypes: true }).catch(() => [])
  const sources: SessionSource[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const agentDir = join(home.path, entry.name)
    const ledgerPath = join(agentDir, 'logs', 'token_ledger.jsonl')
    const s = await stat(ledgerPath).catch(() => null)
    if (!s?.isFile()) continue

    const manifest = await readAgentManifest(agentDir)
    sources.push({
      path: ledgerPath,
      project: projectFromManifest(manifest, entry.name, home.projectPrefix),
      provider: 'lingtai-tui',
    })
  }

  return sources
}

async function discoverLedgers(homes: LingTaiHome[]): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const seen = new Set<string>()

  for (const home of homes) {
    for (const source of await discoverLedgersInHome(home)) {
      if (seen.has(source.path)) continue
      seen.add(source.path)
      sources.push(source)
    }
  }

  return sources
}

function createParser(source: SessionSource): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const agentDir = agentDirFromLedgerPath(source.path)
      const manifest = await readAgentManifest(agentDir)
      const agentId = manifest?.agent_id ?? basename(agentDir)
      const fallbackModel = manifest?.llm?.model ?? 'unknown'
      const fallbackEndpoint = manifest?.llm?.base_url ?? ''
      const project = source.project || projectFromManifest(manifest, basename(agentDir))
      const projectPath = agentDir

      let lineNo = 0
      for await (const line of readSessionLines(source.path)) {
        lineNo += 1
        const entry = parseLedgerLine(line)
        if (!entry) continue

        const obj = entry as JsonObject
        const inputTotal = numericField(obj, 'input')
        const outputTokens = numericField(obj, 'output')
        const reasoningTokens = numericField(obj, 'thinking')
        const cachedInputTokens = numericField(obj, 'cached')
        const totalTokens = inputTotal + outputTokens + reasoningTokens + cachedInputTokens
        if (totalTokens === 0) continue

        // LingTai records provider-normalized input totals plus a separate
        // cached count. Match CodeBurn's normal shape by billing cached tokens
        // in cacheReadInputTokens, not again as fresh input.
        const inputTokens = Math.max(0, inputTotal - cachedInputTokens)
        const model = stringField(obj, 'model') ?? fallbackModel
        const endpoint = stringField(obj, 'endpoint') ?? fallbackEndpoint
        const timestamp = parseTimestamp(entry.ts)
        const sourceLabel = stringField(obj, 'source') ?? 'main'
        const emId = stringField(obj, 'em_id') ?? ''
        const runId = stringField(obj, 'run_id') ?? ''
        const sessionId = runId || `${agentId}:${sourceLabel}`
        const activity = activityForSource(sourceLabel)
        const dedupKey = [
          'lingtai-tui',
          source.path,
          lineNo,
          timestamp,
          model,
          endpoint,
          sourceLabel,
          emId,
          runId,
          inputTotal,
          outputTokens,
          reasoningTokens,
          cachedInputTokens,
        ].join(':')

        const costUSD = calculateCost(
          model,
          inputTokens,
          outputTokens + reasoningTokens,
          0,
          cachedInputTokens,
          0,
        )

        yield {
          provider: 'lingtai-tui',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: cachedInputTokens,
          cachedInputTokens,
          reasoningTokens,
          webSearchRequests: 0,
          costUSD,
          tools: activity.tools,
          bashCommands: [],
          subagentTypes: activity.subagentTypes,
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          turnId: `${sessionId}:line:${lineNo}`,
          userMessage: activity.userMessage,
          sessionId,
          project,
          projectPath,
        }
      }
    },
  }
}

export function createLingTaiTuiProvider(options?: string | LingTaiProviderOptions): Provider {
  const providerOptions = normalizeOptions(options)

  return {
    name: 'lingtai-tui',
    displayName: 'LingTai TUI',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverLedgers(await getLingTaiHomes(providerOptions))
    },

    createSessionParser(source: SessionSource): SessionParser {
      return createParser(source)
    },
  }
}

export const lingtaiTui = createLingTaiTuiProvider()
