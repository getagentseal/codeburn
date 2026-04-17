import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from './fs-utils.js'

const CHARS_PER_TOKEN = 4
const SYSTEM_BASE_TOKENS = 10400
const TOOL_TOKENS_OVERHEAD = 400
const SKILL_FRONTMATTER_TOKENS = 80

export type ContextBudget = {
  systemBase: number
  mcpTools: { count: number; tokens: number }
  skills: { count: number; tokens: number }
  memory: { count: number; tokens: number; files: Array<{ name: string; tokens: number }> }
  total: number
  modelContext: number
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

async function readConfigFile(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null
  const raw = await readSessionFile(path)
  if (raw === null) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function countMcpTools(projectPath?: string): Promise<number> {
  const home = homedir()
  const configPaths = [
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
  ]
  if (projectPath) {
    configPaths.push(join(projectPath, '.mcp.json'))
    configPaths.push(join(projectPath, '.claude', 'settings.json'))
    configPaths.push(join(projectPath, '.claude', 'settings.local.json'))
  }

  const servers = new Set<string>()
  let toolCount = 0

  for (const p of configPaths) {
    const config = await readConfigFile(p)
    if (!config) continue
    const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>
    for (const name of Object.keys(mcpServers)) {
      if (servers.has(name)) continue
      servers.add(name)
      toolCount += 5
    }
  }

  return toolCount
}

async function countSkills(projectPath?: string): Promise<number> {
  const dirs = [join(homedir(), '.claude', 'skills')]
  if (projectPath) dirs.push(join(projectPath, '.claude', 'skills'))

  let count = 0
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        const skillFile = join(dir, entry, 'SKILL.md')
        if (existsSync(skillFile)) count++
      }
    } catch { continue }
  }

  return count
}

async function scanMemoryFiles(projectPath?: string): Promise<Array<{ name: string; tokens: number }>> {
  const home = homedir()
  const files: Array<{ name: string; tokens: number }> = []
  const paths: Array<{ path: string; name: string }> = [
    { path: join(home, '.claude', 'CLAUDE.md'), name: '~/.claude/CLAUDE.md' },
  ]

  if (projectPath) {
    paths.push({ path: join(projectPath, 'CLAUDE.md'), name: 'CLAUDE.md' })
    paths.push({ path: join(projectPath, '.claude', 'CLAUDE.md'), name: '.claude/CLAUDE.md' })
    paths.push({ path: join(projectPath, 'CLAUDE.local.md'), name: 'CLAUDE.local.md' })
  }

  for (const { path, name } of paths) {
    if (!existsSync(path)) continue
    const content = await readSessionFile(path)
    if (content === null) continue
    files.push({ name, tokens: estimateTokens(content) })
  }

  return files
}

export async function estimateContextBudget(projectPath?: string, modelContext = 1_000_000): Promise<ContextBudget> {
  const mcpToolCount = await countMcpTools(projectPath)
  const skillCount = await countSkills(projectPath)
  const memoryFiles = await scanMemoryFiles(projectPath)

  const mcpTokens = mcpToolCount * TOOL_TOKENS_OVERHEAD
  const skillTokens = skillCount * SKILL_FRONTMATTER_TOKENS
  const memoryTokens = memoryFiles.reduce((s, f) => s + f.tokens, 0)
  const total = SYSTEM_BASE_TOKENS + mcpTokens + skillTokens + memoryTokens

  return {
    systemBase: SYSTEM_BASE_TOKENS,
    mcpTools: { count: mcpToolCount, tokens: mcpTokens },
    skills: { count: skillCount, tokens: skillTokens },
    memory: { count: memoryFiles.length, tokens: memoryTokens, files: memoryFiles },
    total,
    modelContext,
  }
}

export async function estimateBudgetsByProject(projectPaths: Map<string, string>): Promise<Map<string, ContextBudget>> {
  const results = new Map<string, ContextBudget>()
  for (const [project, cwd] of projectPaths) {
    const budget = await estimateContextBudget(cwd)
    results.set(project, budget)
  }
  return results
}

export async function discoverProjectCwd(sessionDir: string): Promise<string | null> {
  let files: string[]
  try {
    files = (await readdir(sessionDir)).filter(f => f.endsWith('.jsonl'))
  } catch { return null }
  if (files.length === 0) return null
  const content = await readSessionFile(join(sessionDir, files[0]))
  if (content === null) return null
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.cwd && typeof entry.cwd === 'string') return entry.cwd
    } catch { continue }
  }
  return null
}
