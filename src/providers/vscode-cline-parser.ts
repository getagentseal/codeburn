import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, posix, win32 } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import type { SessionSource, SessionParser, ParsedProviderCall } from './types.js'

type UiMessage = {
  type?: string
  say?: string
  text?: string
  ts?: number
}

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

export function getVSCodeGlobalStoragePath(extensionId: string): string {
  return getVSCodeGlobalStoragePaths(extensionId)[0]!
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

const MODEL_TAG_RE = /<model>([^<]+)<\/model>/
const WORKSPACE_DIR_RE = /Current Workspace Directory \(([^)]+)\)/

type HistoryMeta = { model: string; workspace: string | null }

function extractHistoryMeta(taskDir: string, fallbackModel: string): Promise<HistoryMeta> {
  return readFile(join(taskDir, 'api_conversation_history.json'), 'utf-8')
    .then(raw => {
      const msgs = JSON.parse(raw) as Array<{ role?: string; content?: Array<{ text?: string }> }>
      if (!Array.isArray(msgs)) return { model: fallbackModel, workspace: null }
      let model: string | null = null
      let workspace: string | null = null
      for (const msg of msgs) {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
        for (const block of msg.content) {
          if (typeof block.text !== 'string') continue
          if (!model) {
            const mm = MODEL_TAG_RE.exec(block.text)
            if (mm) model = mm[1].includes('/') ? mm[1].split('/').pop()! : mm[1]
          }
          if (!workspace) {
            const wm = WORKSPACE_DIR_RE.exec(block.text)
            if (wm) workspace = wm[1]
          }
          if (model && workspace) break
        }
        if (model && workspace) break
      }
      return { model: model ?? fallbackModel, workspace }
    })
    .catch(() => ({ model: fallbackModel, workspace: null }))
}

function workspaceToProject(workspace: string): string {
  return basename(workspace) || workspace
}

export function createClineParser(source: SessionSource, seenKeys: Set<string>, providerName: string, fallbackModel = 'cline-auto'): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const taskDir = source.path
      const taskId = basename(taskDir)

      let uiRaw: string
      try {
        uiRaw = await readFile(join(taskDir, 'ui_messages.json'), 'utf-8')
      } catch {
        return
      }

      let uiMessages: UiMessage[]
      try {
        uiMessages = JSON.parse(uiRaw)
      } catch {
        return
      }

      if (!Array.isArray(uiMessages)) return

      const meta = await extractHistoryMeta(taskDir, fallbackModel)
      const model = meta.model
      const project = meta.workspace ? workspaceToProject(meta.workspace) : undefined
      const projectPath = meta.workspace ?? undefined

      let userMessage = ''
      for (const msg of uiMessages) {
        if (msg.type === 'say' && (msg.say === 'user_feedback' || msg.say === 'text')) {
          userMessage = (msg.text ?? '').slice(0, 500)
          break
        }
      }

      const apiReqEntries = uiMessages.filter(m => m.type === 'say' && m.say === 'api_req_started')

      for (const [index, entry] of apiReqEntries.entries()) {
        const dedupKey = `${providerName}:${taskId}:${index}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        let tokensIn = 0
        let tokensOut = 0
        let cacheReads = 0
        let cacheWrites = 0
        let cost: number | undefined

        if (entry.text) {
          try {
            const parsed = JSON.parse(entry.text) as {
              tokensIn?: number
              tokensOut?: number
              cacheReads?: number
              cacheWrites?: number
              cost?: number
            }
            tokensIn = parsed.tokensIn ?? 0
            tokensOut = parsed.tokensOut ?? 0
            cacheReads = parsed.cacheReads ?? 0
            cacheWrites = parsed.cacheWrites ?? 0
            cost = parsed.cost
          } catch {}
        }

        if (tokensIn === 0 && tokensOut === 0) continue

        const timestamp = entry.ts ? new Date(entry.ts).toISOString() : ''
        const costUSD = cost ?? calculateCost(model, tokensIn, tokensOut, cacheWrites, cacheReads, 0)

        yield {
          provider: providerName,
          model,
          inputTokens: tokensIn,
          outputTokens: tokensOut,
          cacheCreationInputTokens: cacheWrites,
          cacheReadInputTokens: cacheReads,
          cachedInputTokens: cacheReads,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools: [],
          bashCommands: [],
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: index === 0 ? userMessage : '',
          sessionId: taskId,
          project,
          projectPath,
        }
      }
    },
  }
}
