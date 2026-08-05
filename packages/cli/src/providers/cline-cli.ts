import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { decodeClineCli, clineCliToolNameMap } from '@codeburn/core/providers/cline-cli'
import type { ClineCliDecodedCall, ClineCliSessionRecords } from '@codeburn/core/providers/cline-cli'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, ProbeRoot, SessionSource, ParsedProviderCall } from './types.js'

const PROVIDER_NAME = 'cline-cli'
const DISPLAY_NAME = 'Cline CLI'

// Mirrors the CLI's own resolution chain, each level individually overridable:
//   sessions := CLINE_SESSION_DATA_DIR ?? <data>/sessions
//   data     := CLINE_DATA_DIR         ?? <root>/data
//   root     := CLINE_DIR              ?? ~/.cline
function clineRootDir(): string {
  return process.env['CLINE_DIR']?.trim() || join(homedir(), '.cline')
}

function clineDataDir(): string {
  return process.env['CLINE_DATA_DIR']?.trim() || join(clineRootDir(), 'data')
}

export function getClineCliSessionsDir(): string {
  return process.env['CLINE_SESSION_DATA_DIR']?.trim() || join(clineDataDir(), 'sessions')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function projectName(workspace: string | undefined): string {
  if (!workspace) return DISPLAY_NAME
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? DISPLAY_NAME
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readSessionFile(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

// Map one rich, cost-free decoder call into the host's ParsedProviderCall. Cost
// re-enters here: a CLI-reported meter figure (present only when actually
// metered, a metered $0 included) is carried as `costBasis: 'measured'`; a
// missing/negative cost falls back to `costBasis: 'estimated'` so the parser.ts
// pricing pass fills `costUSD` from the token buckets — byte-identical to the
// pre-migration in-decoder `calculateCost` (Phase 0, Pattern B). Bash base-name
// extraction (and its `strip-ansi` dependency) stays CLI-side: the core decoder
// carries the raw command strings; the host reduces them to base names here.
function toProviderCall(rich: ClineCliDecodedCall): ParsedProviderCall {
  const measured = rich.reportedCost !== undefined
  return {
    provider: 'cline-cli',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    ...(measured
      ? { costUSD: rich.reportedCost, costBasis: 'measured' as const }
      : { costBasis: 'estimated' as const }),
    costIsEstimated: !measured,
    tools: rich.tools,
    // Same flat list the pre-migration decode produced (no Set): per-command
    // counts keep matching upstream behavior.
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    skills: rich.skills.length > 0 ? rich.skills : undefined,
    subagentTypes: rich.subagentTypes.length > 0 ? rich.subagentTypes : undefined,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    turnId: rich.turnId,
    toolSequence: rich.toolSequence,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    ...(rich.projectPath ? { projectPath: rich.projectPath } : {}),
    ...(rich.workingDirectory ? { workingDirectory: rich.workingDirectory } : {}),
  }
}

export function createClineCliProvider(overrideDir?: string): Provider {
  const sessionsDir = (): string => overrideDir ?? getClineCliSessionsDir()

  return createBridgedProvider<ClineCliDecodedCall>({
    name: PROVIDER_NAME,
    displayName: DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return clineCliToolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: sessionsDir(), label: 'Cline CLI sessions' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dir = sessionsDir()
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const sources: SessionSource[] = []

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue
        const sessionId = entry.name
        const metaPath = join(dir, sessionId, `${sessionId}.json`)
        const meta = await readJson(metaPath)
        if (!isRecord(meta)) continue

        const workspace = nonEmptyString(meta['workspace_root']) ?? nonEmptyString(meta['cwd'])
        sources.push({
          path: metaPath,
          project: projectName(workspace),
          provider: PROVIDER_NAME,
        })
      }

      return sources
    },

    // I/O adapter: read + JSON-parse the session metadata file and its
    // co-located messages file (falling back to the recorded absolute path,
    // which is stale once a session directory is copied between machines), then
    // hand the core decoder ONE composite { meta, messages } record. The
    // decoder stays path-free: the session-id basename fallback and the
    // discovered project label are injected here.
    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      const meta = await readJson(source.path)
      if (!isRecord(meta)) return null
      if (nonEmptyString(meta['session_id']) === undefined) {
        meta['session_id'] = basename(source.path).replace(/\.json$/, '')
      }
      meta['project'] = source.project

      const sibling = join(source.path.replace(/\.json$/, '') + '.messages.json')
      let doc = await readJson(sibling)
      if (!isRecord(doc)) {
        const recorded = nonEmptyString(meta['messages_path'])
        if (recorded) doc = await readJson(recorded)
      }

      const messages = isRecord(doc) && Array.isArray(doc['messages']) ? doc['messages'] : []
      const record: ClineCliSessionRecords = { meta, messages }
      return [record]
    },

    decode: decodeClineCli,
    toProviderCall,
  })
}

export const clineCli = createClineCliProvider()
