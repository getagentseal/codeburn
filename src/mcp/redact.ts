import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { MenubarPayload } from '../menubar-json.js'

let salt: string | undefined

function getSalt(): string {
  if (salt) return salt
  const dir = join(homedir(), '.config', 'codeburn')
  const saltPath = join(dir, '.mcp-salt')
  try {
    salt = readFileSync(saltPath, 'utf-8').trim()
    if (salt) return salt
  } catch { /* first run */ }
  salt = randomBytes(32).toString('hex')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(saltPath, salt + '\n', { mode: 0o600 })
  } catch { /* best-effort */ }
  return salt
}

export function pseudonym(name: string): string {
  return `project-${createHash('sha256').update(getSalt() + name).digest('hex').slice(0, 6)}`
}

function redactSessionDetails(details: Array<{ cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number; date: string; models: Array<{ name: string; cost: number; savingsUSD: number }> }>): Array<{ cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number; date: string; models: Array<{ name: string; cost: number; savingsUSD: number }> }> {
  return details.map(d => ({ ...d, date: '', models: [] }))
}

export function redactProjectNames(payload: MenubarPayload, includeNames: boolean): MenubarPayload {
  // Live sessions name projects and branches; MCP consumers never need them.
  const { liveSessions: _liveSessions, ...rest } = payload
  if (includeNames) return rest
  const timeline = rest.history?.timeline
  return {
    ...rest,
    current: {
      ...payload.current,
      topProjects: payload.current.topProjects.map(p => ({
        ...p,
        name: pseudonym(p.name),
        ...(p.id ? { id: pseudonym(p.id) } : {}),
        sessionDetails: p.sessionDetails ? redactSessionDetails(p.sessionDetails) : [],
      })),
      topSessions: payload.current.topSessions.map(s => ({ ...s, project: pseudonym(s.project) })),
    },
    history: {
      ...payload.history,
      ...(timeline ? {
        timeline: {
          ...timeline,
          sessionSeries: [],
          points: timeline.points.map(point => ({ ...point, sessions: [] })),
        },
      } : {}),
    },
  }
}
