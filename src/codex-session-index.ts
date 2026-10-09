import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { dirname, join } from 'path'
import { createInterface } from 'readline'
import { codex } from './providers/codex.js'
import { sanitizeModelForDisplay } from './models.js'
import { inferSessionProvider } from './session-output.js'
import type { ProjectSummary } from './types.js'

type ThreadName = { title: string; updatedAt: number }
// This optional display index must never turn a report into an unbounded read.
const MAX_INDEX_BYTES = 64 * 1024 * 1024

async function codexHomes(): Promise<string[]> {
  return [...new Set((await codex.probeRoots!()).map(root => dirname(root.path)))]
}

/** The resident server also caches rendered output. Stat the optional indexes
 * per request so creation, replacement, removal and renames bypass that memo. */
export async function codexSessionIndexFingerprint(): Promise<string | null> {
  try {
    const parts: unknown[] = []
    for (const home of await codexHomes()) {
      const path = join(home, 'session_index.jsonl')
      try {
        const info = await stat(path)
        parts.push([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode])
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
        parts.push([path, 'missing'])
      }
    }
    return JSON.stringify(parts)
  } catch {
    return null
  }
}

/** Read append-only name records, without changing the usage caches or index. */
export async function readCodexSessionNames(homes: string[]): Promise<Map<string, string>> {
  const names = new Map<string, ThreadName>()
  for (const home of new Set(homes)) {
    const path = join(home, 'session_index.jsonl')
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_INDEX_BYTES) continue
      const stream = createReadStream(path, { encoding: 'utf8', end: MAX_INDEX_BYTES - 1 })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          let entry: unknown
          try { entry = JSON.parse(line) } catch { continue }
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
          const { id, thread_name: name, updated_at: updatedAt } = entry as Record<string, unknown>
          if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) continue
          const title = sanitizeModelForDisplay(name.trim())
          const timestamp = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN
          const time = Number.isFinite(timestamp) ? timestamp : -Infinity
          const previous = names.get(id)
          // Timestamped records win over older snapshots; equal/missing dates
          // use append order. Blank or malformed records never erase a name.
          if (!previous || time >= previous.updatedAt) names.set(id, { title, updatedAt: time })
        }
      } finally {
        lines.close()
        stream.destroy()
      }
    } catch {
      // Missing, unreadable or concurrently replaced indexes are optional.
    }
  }
  return new Map([...names].map(([id, value]) => [id, value.title]))
}

/** Overlay at the public report boundary, including memory/disk cache hits.
 * Copies preserve the transcript fallback if a later read loses the index. */
export async function applyCodexSessionNames(projects: ProjectSummary[]): Promise<ProjectSummary[]> {
  if (!projects.some(p => p.sessions.some(s => inferSessionProvider(s) === 'codex'))) return projects
  let homes: string[]
  try {
    homes = await codexHomes()
  } catch {
    return projects
  }
  const names = await readCodexSessionNames(homes)
  if (names.size === 0) return projects
  return projects.map(project => ({
    ...project,
    sessions: project.sessions.map(session => {
      // Modern rollouts store payload.id, while CodeBurn's existing identity
      // falls back to the rollout filename. Join by its UUID without changing
      // that identity (or invalidating/rekeying any accounting caches).
      const threadId = session.sessionId.match(/^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1]
      const title = inferSessionProvider(session) === 'codex'
        ? names.get(session.sessionId) ?? (threadId ? names.get(threadId) : undefined)
        : undefined
      return title === undefined ? session : { ...session, title }
    }),
  }))
}
