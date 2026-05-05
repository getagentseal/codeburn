import { mkdir, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'

import type { ClassifiedTurn, DateRange, ParsedApiCall, ProjectSummary, SessionSummary, TokenUsage } from './types.js'

type RedactionKind = 'email' | 'path' | 'project' | 'secret'

type RedactionStats = Record<RedactionKind, number>

export type RedactedShareOptions = {
  label: string
  range: DateRange
  provider: string
  project: string[]
  exclude: string[]
}

type RedactedCall = {
  provider: string
  model: string
  usage: TokenUsage
  costUSD: number
  tools: string[]
  mcpTools: string[]
  skills: string[]
  hasAgentSpawn: boolean
  hasPlanMode: boolean
  speed: 'standard' | 'fast'
  timestamp: string
  bashCommands: string[]
}

type RedactedTurn = {
  timestamp: string
  sessionId: string
  category: string
  subCategory?: string
  retries: number
  hasEdits: boolean
  userMessage: string
  assistantCalls: RedactedCall[]
}

type RedactedSession = {
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  totalCostUSD: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  apiCalls: number
  turns: RedactedTurn[]
}

type RedactedProject = {
  project: string
  projectPath: string
  totalCostUSD: number
  totalApiCalls: number
  sessions: RedactedSession[]
}

export type RedactedShare = {
  schema: 'codeburn.share.v1'
  generated: string
  period: {
    label: string
    start: string
    end: string
  }
  filters: {
    provider: string
    project: string[]
    exclude: string[]
  }
  redaction: {
    applied: true
    placeholders: Record<RedactionKind, string>
    uniqueReplacements: RedactionStats
  }
  summary: {
    projects: number
    sessions: number
    turns: number
    apiCalls: number
    totalCostUSD: number
    totalInputTokens: number
    totalOutputTokens: number
  }
  projects: RedactedProject[]
}

function roundCost(n: number): number {
  return Math.round(n * 10000) / 10000
}

const POSIX_PATH_PREFIXES = [
  'Applications',
  'Library',
  'Users',
  'app',
  'builds',
  'code',
  'data',
  'etc',
  'home',
  'mnt',
  'opt',
  'private',
  'repo',
  'repos',
  'git',
  'projects',
  'scratch',
  'srv',
  'tmp',
  'usr',
  'var',
  'Volumes',
  'work',
  'workspace',
  'workspaces',
]

const posixPathPattern = new RegExp(
  `/(?:${POSIX_PATH_PREFIXES.map(escapeRegex).join('|')})/[^\\s"'\\\`<>|]+(?:/[^\\s"'\\\`<>|]+)*`,
  'gi',
)

class StableRedactor {
  private readonly values: Record<RedactionKind, Map<string, string>> = {
    email: new Map(),
    path: new Map(),
    project: new Map(),
    secret: new Map(),
  }

  stats(): RedactionStats {
    return {
      email: this.values.email.size,
      path: this.values.path.size,
      project: this.values.project.size,
      secret: this.values.secret.size,
    }
  }

  addProjectLabel(value: string): void {
    const trimmed = value.trim()
    if (!trimmed) return
    this.placeholder('project', trimmed)
  }

  redactProjectLabel(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return value
    this.addProjectLabel(trimmed)
    return this.placeholder('project', trimmed)
  }

  redactText(value: string): string {
    let out = value

    out = out.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s:@]+):([^@\s]+)@/g, (match: string, user: string, password: string) =>
      match.replace(`${user}:${password}@`, `${this.placeholder('secret', `${user}:${password}`)}@`),
    )
    out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, email => this.placeholder('email', email))

    out = out.replace(
      /\b(authorization\s*[:=]\s*)(bearer|basic)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
      (_match, prefix: string, scheme: string, token: string) => `${prefix}${scheme} ${this.placeholder('secret', token)}`,
    )

    out = out.replace(
      /\b["']?(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})["']?/gi,
      (_match, key: string, secret: string) => `${key}=${this.placeholder('secret', secret)}`,
    )

    out = out.replace(/\b(sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, token => this.placeholder('secret', token))
    out = out.replace(/\b(gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, token => this.placeholder('secret', token))
    out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, token => this.placeholder('secret', token))
    out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, token => this.placeholder('secret', token))
    out = out.replace(/\b[psr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, token => this.placeholder('secret', token))
    out = out.replace(/\bnpm_[A-Za-z0-9_]{10,}\b/g, token => this.placeholder('secret', token))
    out = out.replace(/\b(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, token => this.placeholder('secret', token))

    out = out.replace(/\\\\[^\\\s"'`<>|]+\\[^\\\s"'`<>|]+(?:\\[^\\\s"'`<>|]+)*/g, path => this.placeholder('path', path))
    out = out.replace(/\b[A-Za-z]:\\[^\\\s"'`<>|]+(?:\\[^\\\s"'`<>|]+)*/g, path => this.placeholder('path', path))
    out = out.replace(/~[/\\][^\s"'`<>|]+/g, path => this.placeholder('path', path))
    out = out.replace(posixPathPattern, path => this.placeholder('path', path))
    out = out.replace(/(^|[\s"'`(=:{\[,;<>|])(\.{1,2}\/[^\s"'`<>|]+(?:\/[^\s"'`<>|]+)*)/g, (_match, prefix: string, path: string) =>
      `${prefix}${this.placeholder('path', path)}`,
    )

    for (const [term, placeholder] of Array.from(this.values.project.entries()).sort((a, b) => b[0].length - a[0].length)) {
      const re = new RegExp(`(^|[^A-Za-z0-9_-])(${escapeRegex(term)})(?=$|[^A-Za-z0-9_-])`, 'gi')
      out = out.replace(re, (match: string, prefix: string, label: string, offset: number, source: string) => {
        const labelStart = offset + prefix.length
        const labelEnd = labelStart + label.length
        if (prefix === '[' && source[labelEnd] === ':') return match
        return `${prefix}${placeholder}`
      })
    }

    return out
  }

  private placeholder(kind: RedactionKind, value: string): string {
    const bucket = this.values[kind]
    const existing = bucket.get(value)
    if (existing) return existing
    const next = `[${kind}:${bucket.size + 1}]`
    bucket.set(value, next)
    return next
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactForShare(value: string): string {
  return new StableRedactor().redactText(value)
}

function redactCall(call: ParsedApiCall, redactor: StableRedactor): RedactedCall {
  return {
    provider: call.provider,
    model: redactor.redactText(call.model),
    usage: call.usage,
    costUSD: roundCost(call.costUSD),
    tools: call.tools.map(t => redactor.redactText(t)),
    mcpTools: call.mcpTools.map(t => redactor.redactText(t)),
    skills: call.skills.map(skill => redactor.redactText(skill)),
    hasAgentSpawn: call.hasAgentSpawn,
    hasPlanMode: call.hasPlanMode,
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands.map(cmd => redactor.redactText(cmd)),
  }
}

function redactTurn(turn: ClassifiedTurn, redactor: StableRedactor): RedactedTurn {
  return {
    timestamp: turn.timestamp,
    sessionId: redactor.redactText(turn.sessionId),
    category: turn.category,
    ...(turn.subCategory ? { subCategory: redactor.redactText(turn.subCategory) } : {}),
    retries: turn.retries,
    hasEdits: turn.hasEdits,
    userMessage: redactor.redactText(turn.userMessage),
    assistantCalls: turn.assistantCalls.map(call => redactCall(call, redactor)),
  }
}

function redactSession(session: SessionSummary, redactor: StableRedactor): RedactedSession {
  return {
    sessionId: redactor.redactText(session.sessionId),
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: session.lastTimestamp,
    totalCostUSD: roundCost(session.totalCostUSD),
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    totalCacheReadTokens: session.totalCacheReadTokens,
    totalCacheWriteTokens: session.totalCacheWriteTokens,
    apiCalls: session.apiCalls,
    turns: session.turns.map(turn => redactTurn(turn, redactor)),
  }
}

export function buildRedactedShare(projects: ProjectSummary[], options: RedactedShareOptions): RedactedShare {
  const redactor = new StableRedactor()
  const sessions = projects.flatMap(project => project.sessions)
  const turns = sessions.flatMap(session => session.turns)

  for (const project of projects) redactor.addProjectLabel(project.project)
  for (const project of options.project) redactor.addProjectLabel(project)
  for (const project of options.exclude) redactor.addProjectLabel(project)

  const redactedProjects: RedactedProject[] = projects.map(project => ({
    project: redactor.redactProjectLabel(project.project),
    projectPath: redactor.redactText(project.projectPath),
    totalCostUSD: roundCost(project.totalCostUSD),
    totalApiCalls: project.totalApiCalls,
    sessions: project.sessions.map(session => redactSession(session, redactor)),
  }))

  const uniqueReplacements = redactor.stats()

  return {
    schema: 'codeburn.share.v1',
    generated: new Date().toISOString(),
    period: {
      label: options.label,
      start: options.range.start.toISOString(),
      end: options.range.end.toISOString(),
    },
    filters: {
      provider: options.provider,
      project: options.project.map(project => redactor.redactProjectLabel(project)),
      exclude: options.exclude.map(project => redactor.redactProjectLabel(project)),
    },
    redaction: {
      applied: true,
      placeholders: {
        email: '[email:<index>]',
        path: '[path:<index>]',
        project: '[project:<index>]',
        secret: '[secret:<index>]',
      },
      uniqueReplacements,
    },
    summary: {
      projects: projects.length,
      sessions: sessions.length,
      turns: turns.length,
      apiCalls: projects.reduce((sum, project) => sum + project.totalApiCalls, 0),
      totalCostUSD: roundCost(projects.reduce((sum, project) => sum + project.totalCostUSD, 0)),
      totalInputTokens: sessions.reduce((sum, session) => sum + session.totalInputTokens, 0),
      totalOutputTokens: sessions.reduce((sum, session) => sum + session.totalOutputTokens, 0),
    },
    projects: redactedProjects,
  }
}

export async function writeRedactedShare(share: RedactedShare, outputPath: string): Promise<string> {
  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(share, null, 2), 'utf-8')
  return target
}
