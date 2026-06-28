import { readdir, stat } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionLines, readSessionFileSync } from '../fs-utils.js'
import { discoverAllSessions } from '../providers/index.js'
import type { DateRange } from '../types.js'
import { RECENT_WINDOW_MS, FILE_READ_CONCURRENCY } from './constants.js'
import type { ToolCall, ApiCallMeta, ScanData, ScanFileResult, McpConfigEntry } from './types.js'

async function collectJsonlFiles(dirPath: string): Promise<string[]> {
  const files = await readdir(dirPath).catch(() => [])
  const result = files.filter(f => f.endsWith('.jsonl')).map(f => join(dirPath, f))
  for (const entry of files) {
    if (entry.endsWith('.jsonl')) continue
    const subPath = join(dirPath, entry, 'subagents')
    const subFiles = await readdir(subPath).catch(() => [])
    for (const sf of subFiles) {
      if (sf.endsWith('.jsonl')) result.push(join(subPath, sf))
    }
  }
  return result
}

async function isFileStaleForRange(filePath: string, range: DateRange | undefined): Promise<boolean> {
  if (!range) return false
  try {
    const s = await stat(filePath)
    return s.mtimeMs < range.start.getTime()
  } catch { return false }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  async function next(): Promise<void> {
    while (idx < items.length) {
      const current = idx++
      await worker(items[current])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()))
}

function inRange(timestamp: string | undefined, range: DateRange | undefined): boolean {
  if (!range) return true
  if (!timestamp) return false
  const ts = new Date(timestamp)
  return ts >= range.start && ts <= range.end
}

function isRecent(timestamp: string | undefined, cutoff: number): boolean {
  if (!timestamp) return false
  return new Date(timestamp).getTime() >= cutoff
}

export async function scanJsonlFile(
  filePath: string,
  project: string,
  dateRange: DateRange | undefined,
  recentCutoffMs = Date.now() - RECENT_WINDOW_MS,
): Promise<ScanFileResult> {
  const calls: ToolCall[] = []
  const cwds: string[] = []
  const apiCalls: ApiCallMeta[] = []
  const userMessages: string[] = []
  const sessionId = basename(filePath, '.jsonl')
  let lastVersion = ''

  for await (const line of readSessionLines(filePath)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) } catch { continue }

    if (entry.version && typeof entry.version === 'string') lastVersion = entry.version

    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
    const withinRange = inRange(ts, dateRange)
    const recent = isRecent(ts, recentCutoffMs)

    if (entry.cwd && typeof entry.cwd === 'string' && withinRange) cwds.push(entry.cwd)

    if (entry.type === 'user') {
      if (!withinRange) continue
      const msg = entry.message as Record<string, unknown> | undefined
      const msgContent = msg?.content
      if (typeof msgContent === 'string') {
        userMessages.push(msgContent)
      } else if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            userMessages.push(block.text)
          }
        }
      }
      continue
    }

    if (entry.type !== 'assistant') continue
    if (!withinRange) continue

    const msg = entry.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (usage) {
      const cacheCreate = (usage.cache_creation_input_tokens as number) ?? 0
      if (cacheCreate > 0) apiCalls.push({ cacheCreationTokens: cacheCreate, version: lastVersion, recent })
    }

    const blocks = msg?.content
    if (!Array.isArray(blocks)) continue

    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      calls.push({
        name: block.name as string,
        input: (block.input as Record<string, unknown>) ?? {},
        sessionId,
        project,
        recent,
      })
    }
  }

  return { calls, cwds, apiCalls, userMessages }
}

export async function scanSessions(dateRange?: DateRange): Promise<ScanData> {
  const sources = await discoverAllSessions('claude')
  const allCalls: ToolCall[] = []
  const allCwds = new Set<string>()
  const allApiCalls: ApiCallMeta[] = []
  const allUserMessages: string[] = []

  const tasks: Array<{ file: string; project: string }> = []
  for (const source of sources) {
    const files = await collectJsonlFiles(source.path)
    for (const file of files) {
      if (await isFileStaleForRange(file, dateRange)) continue
      tasks.push({ file, project: source.project })
    }
  }

  await runWithConcurrency(tasks, FILE_READ_CONCURRENCY, async ({ file, project }) => {
    const { calls, cwds, apiCalls, userMessages } = await scanJsonlFile(file, project, dateRange)
    allCalls.push(...calls)
    for (const cwd of cwds) allCwds.add(cwd)
    allApiCalls.push(...apiCalls)
    allUserMessages.push(...userMessages)
  })

  return { toolCalls: allCalls, projectCwds: allCwds, apiCalls: allApiCalls, userMessages: allUserMessages }
}

// ============================================================================
// Shared helpers
// ============================================================================

function readJsonFile(path: string): Record<string, unknown> | null {
  const raw = readSessionFileSync(path)
  if (raw === null) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function shortHomePath(absPath: string): string {
  const home = homedir()
  return absPath.startsWith(home) ? '~' + absPath.slice(home.length) : absPath
}

export function isReadTool(name: string): boolean {
  return name === 'Read' || name === 'FileReadTool'
}

export function loadMcpConfigs(projectCwds: Iterable<string>): Map<string, McpConfigEntry> {
  const servers = new Map<string, McpConfigEntry>()
  const configPaths = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
  ]
  for (const cwd of projectCwds) {
    configPaths.push(join(cwd, '.mcp.json'))
    configPaths.push(join(cwd, '.claude', 'settings.json'))
    configPaths.push(join(cwd, '.claude', 'settings.local.json'))
  }

  for (const p of configPaths) {
    if (!existsSync(p)) continue
    const config = readJsonFile(p)
    if (!config) continue
    let mtime = 0
    try { mtime = statSync(p).mtimeMs } catch {}
    const serversObj = (config.mcpServers ?? {}) as Record<string, unknown>
    for (const name of Object.keys(serversObj)) {
      const normalized = name.replace(/:/g, '_')
      const existing = servers.get(normalized)
      if (!existing || existing.mtime < mtime) {
        servers.set(normalized, { normalized, original: name, mtime })
      }
    }
  }
  return servers
}
