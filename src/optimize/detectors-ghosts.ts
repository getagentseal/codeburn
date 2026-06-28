import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { readSessionFileSync } from '../fs-utils.js'
import { formatTokens } from '../format.js'
import {
  TOKENS_PER_AGENT_DEF,
  TOKENS_PER_SKILL_DEF,
  TOKENS_PER_COMMAND_DEF,
  GHOST_NAMES_PREVIEW,
  GHOST_CLEANUP_COMMANDS_LIMIT,
  GHOST_AGENTS_HIGH_THRESHOLD,
  GHOST_AGENTS_MEDIUM_THRESHOLD,
  GHOST_SKILLS_HIGH_THRESHOLD,
  GHOST_SKILLS_MEDIUM_THRESHOLD,
  GHOST_COMMANDS_MEDIUM_THRESHOLD,
  COMMAND_PATTERN,
  SHELL_PROFILES,
  BASH_RECOMMENDED_LIMIT,
  BASH_DEFAULT_LIMIT,
  BASH_TOKENS_PER_CHAR,
} from './constants.js'
import type { ToolCall, WasteFinding } from './types.js'

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    return entries.filter(e => e.endsWith('.md')).map(e => e.replace(/\.md$/, ''))
  } catch { return [] }
}

async function listSkillDirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    const names: string[] = []
    for (const entry of entries) {
      if (existsSync(join(dir, entry, 'SKILL.md'))) names.push(entry)
    }
    return names
  } catch { return [] }
}

export async function detectGhostAgents(calls: ToolCall[]): Promise<WasteFinding | null> {
  const defined = await listMarkdownFiles(join(homedir(), '.claude', 'agents'))
  if (defined.length === 0) return null

  const invoked = new Set<string>()
  for (const call of calls) {
    if (call.name !== 'Agent' && call.name !== 'Task') continue
    const subType = call.input.subagent_type as string | undefined
    if (subType) invoked.add(subType)
  }

  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_AGENT_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    title: `${ghosts.length} custom agent${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `Defined in ~/.claude/agents/ but never invoked in this period: ${list}. Each adds ~${TOKENS_PER_AGENT_DEF} tokens to the Task tool schema on every session.`,
    impact: ghosts.length >= GHOST_AGENTS_HIGH_THRESHOLD ? 'high' : ghosts.length >= GHOST_AGENTS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused agent${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/agents/${name}.md ~/.claude/agents/.archived/`).join('\n'),
    },
  }
}

export async function detectGhostSkills(calls: ToolCall[]): Promise<WasteFinding | null> {
  const defined = await listSkillDirs(join(homedir(), '.claude', 'skills'))
  if (defined.length === 0) return null

  const invoked = new Set<string>()
  for (const call of calls) {
    if (call.name !== 'Skill') continue
    const skillName = (call.input.skill as string) || (call.input.name as string)
    if (skillName) invoked.add(skillName)
  }

  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_SKILL_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    title: `${ghosts.length} skill${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `In ~/.claude/skills/ but not invoked this period: ${list}. Each adds ~${TOKENS_PER_SKILL_DEF} tokens of metadata to every session.`,
    impact: ghosts.length >= GHOST_SKILLS_HIGH_THRESHOLD ? 'high' : ghosts.length >= GHOST_SKILLS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused skill${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/skills/${name} ~/.claude/skills/.archived/`).join('\n'),
    },
  }
}

export async function detectGhostCommands(userMessages: string[]): Promise<WasteFinding | null> {
  const defined = await listMarkdownFiles(join(homedir(), '.claude', 'commands'))
  if (defined.length === 0) return null

  const invoked = new Set<string>()
  for (const msg of userMessages) {
    COMMAND_PATTERN.lastIndex = 0
    for (const m of msg.matchAll(COMMAND_PATTERN)) {
      const name = (m[1] || m[2] || '').trim()
      if (name) invoked.add(name)
    }
  }

  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_COMMAND_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    title: `${ghosts.length} slash command${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `In ~/.claude/commands/ but not referenced this period: ${list}. Each adds ~${TOKENS_PER_COMMAND_DEF} tokens of definition per session.`,
    impact: ghosts.length >= GHOST_COMMANDS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused command${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/commands/${name}.md ~/.claude/commands/.archived/`).join('\n'),
    },
  }
}

function readShellProfileLimit(): number | null {
  for (const profile of SHELL_PROFILES) {
    const path = join(homedir(), profile)
    if (!existsSync(path)) continue
    const content = readSessionFileSync(path)
    if (content === null) continue
    const match = content.match(/^\s*export\s+BASH_MAX_OUTPUT_LENGTH\s*=\s*['"]?(\d+)['"]?/m)
    if (match) return parseInt(match[1], 10)
  }
  return null
}

export function detectBashBloat(): WasteFinding | null {
  const profileLimit = readShellProfileLimit()
  const envLimit = process.env['BASH_MAX_OUTPUT_LENGTH']
  const configured = profileLimit ?? (envLimit ? parseInt(envLimit, 10) : null)

  if (configured !== null && configured <= BASH_RECOMMENDED_LIMIT) return null

  const limit = configured ?? BASH_DEFAULT_LIMIT
  const extraChars = limit - BASH_RECOMMENDED_LIMIT
  const tokensSaved = Math.round(extraChars * BASH_TOKENS_PER_CHAR)

  return {
    title: 'Shrink bash output limit',
    explanation: `Your bash output cap is ${(limit / 1000).toFixed(0)}K chars (${configured ? 'configured' : 'default'}). Most output fits in ${(BASH_RECOMMENDED_LIMIT / 1000).toFixed(0)}K. The extra ~${formatTokens(tokensSaved)} tokens per bash call is trailing noise.`,
    impact: 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'shell-config',
      label: 'Add to ~/.zshrc or ~/.bashrc:',
      text: `export BASH_MAX_OUTPUT_LENGTH=${BASH_RECOMMENDED_LIMIT}`,
    },
  }
}
