import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

const toolNameMap: Record<string, string> = {
  shell_command: 'Bash',
  run_command: 'Bash',
  monitor_command: 'Bash',
  kill_shell: 'Bash',
  shell_output: 'Bash',
  shell_tasks: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  read_directory: 'Glob',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  activate_skill: 'Skill',
  agent: 'Agent',
  agent_output: 'Agent',
  ask_user_question: 'AskUserQuestion',
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }

type Line = {
  type?: string
  id?: string
  cwd?: string
  timestamp?: string
  model?: string
  message?: { role?: string; content?: string | Block[]; meta?: { messageId?: string } }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    costUsd?: number
  }
}

export function getCommandCodeProjectsDir(): string {
  return join(process.env['CODEBURN_COMMANDCODE_DIR'] || join(homedir(), '.commandcode'), 'projects')
}

function tokens(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function userText(content: string | Block[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.find(b => b.type === 'text' && typeof b.text === 'string')?.text ?? ''
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      let sessionId = basename(source.path, '.jsonl')
      let cwd: string | undefined
      let userMessage = ''

      for (const text of raw.split('\n')) {
        if (!text.trim()) continue
        let line: Line
        try {
          line = JSON.parse(text) as Line
        } catch {
          continue
        }

        if (line.type === 'session') {
          sessionId = str(line.id) ?? sessionId
          cwd = str(line.cwd) ?? cwd
          continue
        }
        if (line.type !== 'message' || !line.message) continue

        if (line.message.role === 'user') {
          const prompt = userText(line.message.content)
          if (prompt) userMessage = prompt
          continue
        }
        if (line.message.role !== 'assistant' || !line.usage) continue

        const id = str(line.id)
        const timestamp = str(line.timestamp)
        if (!id || !timestamp) continue
        // `id` is 8 hex chars, unique only within one file. meta.messageId is a
        // full uuid and survives forks, which copy the parent's entries verbatim.
        const deduplicationKey = `command-code:${str(line.message.meta?.messageId) ?? id}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        const u = line.usage
        const cacheRead = tokens(u.cacheReadTokens)
        const cacheWrite = tokens(u.cacheWriteTokens)
        // inputTokens already includes the cache reads.
        const input = Math.max(0, tokens(u.inputTokens) - cacheRead)
        const output = tokens(u.outputTokens)
        const model = str(line.model) ?? 'unknown'
        const reported = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0

        const tools: string[] = []
        const bashCommands: string[] = []
        const skills: string[] = []
        const subagentTypes: string[] = []
        const turn: ToolCall[] = []
        let webSearchRequests = 0
        for (const block of Array.isArray(line.message.content) ? line.message.content : []) {
          if (block.type !== 'tool_use' || !str(block.name)) continue
          const tool = toolNameMap[block.name!] ?? block.name!
          const args = block.input ?? {}
          const call: ToolCall = { tool }
          const file = str(args['file_path']) ?? str(args['path'])
          if (file) call.file = file
          const command = str(args['command'])
          if (command) {
            call.command = command
            if (tool === 'Bash') bashCommands.push(...extractBashCommands(command))
          }
          if (block.name === 'activate_skill') {
            const skill = str(args['name']) ?? str(args['skill'])
            if (skill) skills.push(skill)
          }
          const subagentType = block.name === 'agent' ? str(args['subagent_type']) : undefined
          if (subagentType) subagentTypes.push(subagentType)
          if (tool === 'WebSearch') webSearchRequests++
          tools.push(tool)
          turn.push(call)
        }

        yield {
          provider: 'command-code',
          model,
          inputTokens: input,
          outputTokens: output,
          cacheCreationInputTokens: cacheWrite,
          cacheReadInputTokens: cacheRead,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests,
          costUSD: reported ? u.costUsd! : calculateCost(model, input, output, cacheWrite, cacheRead, 0),
          ...(reported ? { costFromBilling: true } : { costIsEstimated: true }),
          tools,
          bashCommands,
          skills,
          subagentTypes,
          timestamp,
          speed: 'standard',
          deduplicationKey,
          turnId: `${sessionId}:${id}`,
          ...(turn.length > 0 ? { toolSequence: [turn] } : {}),
          userMessage,
          sessionId,
          project: cwd ? (cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? source.project) : source.project,
          ...(cwd ? { projectPath: cwd, workingDirectory: cwd } : {}),
        }
      }
    },
  }
}

export function createCommandCodeProvider(projectsDir?: string): Provider {
  const dir = projectsDir ?? getCommandCodeProjectsDir()

  return {
    name: 'command-code',
    displayName: 'Command Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: dir, label: 'projects' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      const projects = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const project of projects) {
        if (!project.isDirectory()) continue
        const files = await readdir(join(dir, project.name), { withFileTypes: true }).catch(() => [])
        for (const file of files) {
          // <id>.jsonl only: <id>.checkpoints.jsonl and <id>.prompts.jsonl are sidecars.
          if (!file.isFile() || !/^[^.]+\.jsonl$/.test(file.name)) continue
          sources.push({ path: join(dir, project.name, file.name), project: project.name, provider: 'command-code' })
        }
      }
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const commandCode = createCommandCodeProvider()
