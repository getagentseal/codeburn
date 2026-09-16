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

function hashed(input: string): string {
  return createHash('sha256').update(getSalt() + input).digest('hex').slice(0, 6)
}

export function pseudonym(name: string): string {
  return `project-${hashed(name)}`
}

/// Branch names carry ticket ids, customer names and feature codenames, so a
/// caller that asked not to see project names must not see them either. Stable
/// per branch like the project pseudonym, and domain-separated so a branch and a
/// project sharing a name do not hash to the same digest.
function branchPseudonym(branch: string): string {
  return `branch-${hashed(`branch:${branch}`)}`
}

/// Drill-through session identity (`sessionId`): opaque, but it is the row key
/// that pairs with `projectKey`, and a Codex id embeds the rollout timestamp
/// that this pass blanks out of `date`. Pseudonymized rather than dropped so
/// rows referring to the same session still line up.
function sessionPseudonym(id: string): string {
  return `session-${hashed(`session:${id}`)}`
}

/// PR rows name the repository in both the full URL (the aggregation key) and
/// the `owner/repo#123` label, so a caller that asked not to see project names
/// must not see them either. Pseudonymized from the URL so rows referring to
/// the same PR still line up; the numbers stay untouched.
function prPseudonym(url: string): string {
  return `pr-${hashed(`pr:${url}`)}`
}

type SessionDetails = MenubarPayload['current']['topProjects'][number]['sessionDetails']

function redactSessionDetails(details: SessionDetails): SessionDetails {
  return details.map(d => ({
    ...d,
    date: '',
    models: [],
    ...(d.sessionId ? { sessionId: sessionPseudonym(d.sessionId) } : {}),
  }))
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
      topSessions: payload.current.topSessions.map(s => ({
        ...s,
        project: pseudonym(s.project),
        // `projectKey` is the raw sessions-list row key: a dash-encoded absolute
        // working directory. Hashed like `topProjects[].id`, which is the same
        // kind of value.
        ...(s.projectKey ? { projectKey: pseudonym(s.projectKey) } : {}),
        ...(s.sessionId ? { sessionId: sessionPseudonym(s.sessionId) } : {}),
      })),
      ...(payload.current.byBranch
        ? {
            byBranch: payload.current.byBranch.map(b => ({
              ...b,
              // A null branch is unbranched spend inside a branch-bearing
              // session, not a name: it stays null.
              branch: b.branch === null ? null : branchPseudonym(b.branch),
            })),
          }
        : {}),
      ...(payload.current.pullRequests
        ? {
            pullRequests: {
              ...payload.current.pullRequests,
              rows: payload.current.pullRequests.rows.map(row => ({
                ...row,
                url: prPseudonym(row.url),
                label: prPseudonym(row.url),
              })),
            },
          }
        : {}),
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
