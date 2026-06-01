import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { Provider, SessionSource, SessionParser } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'swe-1.6': 'SWE-1.6',
  'swe-1.5': 'SWE-1.5',
  'swe-grep': 'SWE-Grep',
  'swe-1': 'SWE-1',
  'windsurf-auto': 'Windsurf Auto',
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
}

const toolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  run_command: 'Bash',
  bash: 'Bash',
  browser_search: 'WebSearch',
  web_search: 'WebSearch',
  mcp_tool: 'MCP',
  agent_spawn: 'Agent',
  think: 'Think',
  planning: 'Plan',
}

function getWindsurfDir(): string {
  if (process.env.WINDSURF_HOME) return process.env.WINDSURF_HOME
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Windsurf')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || '', 'Windsurf')
  }
  return join(homedir(), '.config', 'Windsurf')
}

function createParser(_source: SessionSource): SessionParser {
  return {
    async *parse() {
      // No session data is currently accessible.  Windsurf stores
      // conversations in encrypted .pb files and does not expose a
      // local API that third-party tools can read.
      return
    },
  }
}

export function createWindsurfProvider(windsurfDir?: string): Provider {
  const dir = windsurfDir ?? getWindsurfDir()

  return {
    name: 'windsurf',
    displayName: 'Windsurf',

    modelDisplayName(model: string): string {
      for (const [key, name] of Object.entries(modelDisplayNames)) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] || rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!existsSync(dir)) return []
      // Windsurf session data is stored in encrypted protobuf files
      // (~/.codeium/windsurf/cascade/*.pb) and is not currently
      // accessible to third-party tools.  Return empty until Windsurf
      // exposes a local API (e.g. SQLite or JSONL like Cursor).
      return []
    },

    createSessionParser(source: SessionSource): SessionParser {
      return createParser(source)
    },
  }
}

export const windsurf = createWindsurfProvider()
