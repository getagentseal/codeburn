import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createClineParser } from './vscode-cline-parser.js'
import type { Provider, SessionSource, SessionParser } from './types.js'

const EXTENSION_ID = 'ibm.bob-code'

function getBobGlobalStoragePath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID)
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID)
  }
  return join(homedir(), '.config', 'IBM Bob', 'User', 'globalStorage', EXTENSION_ID)
}

async function discoverBobTasks(overrideDir?: string): Promise<SessionSource[]> {
  const baseDir = overrideDir ?? getBobGlobalStoragePath()
  const tasksDir = join(baseDir, 'tasks')
  const sources: SessionSource[] = []

  let taskDirs: string[]
  try {
    taskDirs = await readdir(tasksDir)
  } catch {
    return sources
  }

  for (const taskId of taskDirs) {
    const taskDir = join(tasksDir, taskId)
    const dirStat = await stat(taskDir).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    const uiPath = join(taskDir, 'ui_messages.json')
    const uiStat = await stat(uiPath).catch(() => null)
    if (!uiStat?.isFile()) continue

    sources.push({ path: taskDir, project: 'IBM Bob', provider: 'bob' })
  }

  return sources
}

export function createBobProvider(overrideDir?: string): Provider {
  return {
    name: 'bob',
    displayName: 'IBM Bob',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverBobTasks(overrideDir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createClineParser(source, seenKeys, 'bob')
    },
  }
}

export const bob = createBobProvider()
