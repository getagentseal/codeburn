import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

import { buildAssistantCall, sanitize, type MessageData, type PartData } from './session-message.js'
import type { SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// OpenCode 1.1+ stores sessions as file-based JSON instead of a SQLite DB:
//   storage/session/<projectID>/<sessionID>.json   session metadata
//   storage/message/<sessionID>/<messageID>.json    one file per message
//   storage/part/<messageID>/<partID>.json          one file per part
// The message/part shape matches the SQLite layout, so the per-message build
// logic is shared via buildAssistantCall.

type SessionMeta = {
  id?: string
  directory?: string
  title?: string
  time?: { created?: number }
}

type FileMessageData = MessageData & {
  id?: string
  time?: { created?: number }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function readParts(dataDir: string, messageId: string): Promise<PartData[]> {
  const dir = join(dataDir, 'storage', 'part', messageId)
  let files: string[]
  try {
    files = (await readdir(dir)).sort()
  } catch {
    return []
  }
  const parts: PartData[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const part = await readJson<PartData>(join(dir, f))
    if (part) parts.push(part)
  }
  return parts
}

export async function discoverOpenCodeFileSessions(
  dataDir: string,
  providerName: string,
): Promise<SessionSource[]> {
  const sessionRoot = join(dataDir, 'storage', 'session')
  let projectDirs: string[]
  try {
    projectDirs = await readdir(sessionRoot)
  } catch {
    return []
  }

  const sources: SessionSource[] = []
  for (const project of projectDirs) {
    let files: string[]
    try {
      files = await readdir(join(sessionRoot, project))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const path = join(sessionRoot, project, f)
      const meta = await readJson<SessionMeta>(path)
      if (!meta?.id) continue
      sources.push({
        path,
        project: sanitize(meta.directory || meta.title || ''),
        provider: providerName,
      })
    }
  }
  return sources
}

export function createOpenCodeFileSessionParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dataDir: string,
  providerName: string,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const meta = await readJson<SessionMeta>(source.path)
      if (!meta?.id) return
      const sessionId = meta.id

      const messageDir = join(dataDir, 'storage', 'message', sessionId)
      let messageFiles: string[]
      try {
        messageFiles = await readdir(messageDir)
      } catch {
        return
      }

      const messages: Array<{ id: string; data: FileMessageData }> = []
      for (const f of messageFiles) {
        if (!f.endsWith('.json')) continue
        const data = await readJson<FileMessageData>(join(messageDir, f))
        if (!data) continue
        messages.push({ id: data.id ?? f.replace(/\.json$/, ''), data })
      }
      messages.sort((a, b) => {
        const byTime = (a.data.time?.created ?? 0) - (b.data.time?.created ?? 0)
        if (byTime !== 0) return byTime
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })

      let currentUserMessage = ''
      for (const { id, data } of messages) {
        if (data.role === 'user') {
          const parts = await readParts(dataDir, id)
          const text = parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .filter(Boolean)
            .join(' ')
          if (text) currentUserMessage = text
          continue
        }

        if (data.role !== 'assistant' && data.role !== 'model') continue

        const dedupKey = `${providerName}:${sessionId}:${id}`
        if (seenKeys.has(dedupKey)) continue

        const parts = await readParts(dataDir, id)
        const call = buildAssistantCall({
          providerName,
          dedupKey,
          sessionId,
          data,
          parts,
          timeCreatedMs: data.time?.created ?? meta.time?.created ?? 0,
          userMessage: currentUserMessage,
        })
        if (!call) continue

        seenKeys.add(dedupKey)
        yield call
      }
    },
  }
}
