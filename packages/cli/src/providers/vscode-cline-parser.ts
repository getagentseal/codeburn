import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, posix, win32 } from 'path'
import { homedir } from 'os'

import { decodeVscodeCline } from '@codeburn/core/providers/vscode-cline'
import type { ClineRecordEnvelope, VscodeClineDecodedCall } from '@codeburn/core/providers/vscode-cline'

import type { ParsedProviderCall, SessionSource } from './types.js'

export function getVSCodeGlobalStoragePaths(extensionId: string, homeDir = homedir(), platform = process.platform): string[] {
  const pathJoin = platform === 'win32' ? win32.join : posix.join

  if (platform === 'darwin') {
    return [
      pathJoin(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }

  if (platform === 'win32') {
    return [
      pathJoin(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }

  return [
    pathJoin(homeDir, '.config', 'Code', 'User', 'globalStorage', extensionId),
    pathJoin(homeDir, '.config', 'Code - Insiders', 'User', 'globalStorage', extensionId),
    pathJoin(homeDir, '.config', 'VSCodium', 'User', 'globalStorage', extensionId),
  ]
}

export async function discoverClineTasks(extensionId: string, providerName: string, displayName: string, overrideDir?: string | string[]): Promise<SessionSource[]> {
  const baseDirs = overrideDir
    ? (Array.isArray(overrideDir) ? overrideDir : [overrideDir])
    : getVSCodeGlobalStoragePaths(extensionId)
  return discoverClineTasksInBaseDirs(baseDirs, providerName, displayName)
}

export async function discoverClineTasksInBaseDirs(baseDirs: string[], providerName: string, displayName: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const seen = new Set<string>()
  for (const baseDir of baseDirs) {
    for (const source of await discoverClineTasksInBaseDir(baseDir, providerName, displayName)) {
      if (seen.has(source.path)) continue
      seen.add(source.path)
      sources.push(source)
    }
  }
  return sources
}

async function discoverClineTasksInBaseDir(baseDir: string, providerName: string, displayName: string): Promise<SessionSource[]> {
  const tasksDir = join(baseDir, 'tasks')
  const sources: SessionSource[] = []

  let taskDirs: string[]
  try {
    taskDirs = await readdir(tasksDir)
  } catch {
    return sources
  }

  for (const taskId of taskDirs) {
    const taskDir = join(tasksDir, taskId)
    const dirStat = await stat(taskDir).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    const uiPath = join(taskDir, 'ui_messages.json')
    const uiStat = await stat(uiPath).catch(() => null)
    if (!uiStat?.isFile()) continue

    sources.push({ path: taskDir, project: displayName, provider: providerName })
  }

  return sources
}

/** I/O adapter: read one task directory into the single envelope core decodes. */
export async function readClineRecords(source: SessionSource): Promise<unknown[] | null> {
  const taskDir = source.path
  let uiRaw: string
  try {
    uiRaw = await readFile(join(taskDir, 'ui_messages.json'), 'utf-8')
  } catch {
    return null            // reproduces the early `return` at :133-138
  }
  const historyRaw = await readFile(join(taskDir, 'api_conversation_history.json'), 'utf-8')
    .catch(() => null)     // reproduces the .catch at :120
  const envelope: ClineRecordEnvelope = { kind: 'cline-task', taskId: basename(taskDir), uiRaw, historyRaw }
  return [envelope]
}

/** Host-side map: rich call -> ParsedProviderCall. Cost re-enters here. */
export function toClineProviderCall(rich: VscodeClineDecodedCall): ParsedProviderCall {
  return {
    provider: rich.provider,
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    ...(rich.measuredCostUSD !== undefined
      ? { costUSD: rich.measuredCostUSD, costBasis: 'measured' as const }
      : { costBasis: 'estimated' as const }),
    tools: rich.tools,
    bashCommands: rich.rawBashCommands,
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    project: rich.project,
    projectPath: rich.projectPath,
  }
}
