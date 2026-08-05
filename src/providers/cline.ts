import { stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { discoverClineTasks, createClineParser, clineTaskRoots } from './vscode-cline-parser.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser } from './types.js'

const EXTENSION_ID = 'saoudrizwan.claude-dev'

export function getClineDataPath(): string {
  return join(homedir(), '.cline', 'data')
}

function normalizeOverrideDirs(overrideDirs?: string | string[]): string[] | undefined {
  if (overrideDirs === undefined) return undefined
  // Cline has several default roots, so tests and future callers can override one or all.
  return Array.isArray(overrideDirs) ? overrideDirs : [overrideDirs]
}

async function dedupeTaskSources(sources: SessionSource[]): Promise<SessionSource[]> {
  const candidates = await Promise.all(sources.map(async source => ({
    source,
    mtimeMs: (await stat(join(source.path, 'ui_messages.json')).catch(() => null))?.mtimeMs ?? 0,
  })))

  const seenTaskIds = new Set<string>()
  const deduped: SessionSource[] = []

  for (const { source } of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const taskId = basename(source.path)
    if (seenTaskIds.has(taskId)) continue
    seenTaskIds.add(taskId)
    deduped.push(source)
  }

  return deduped
}

export function createClineProvider(overrideDirs?: string | string[]): Provider {
  const configuredDirs = normalizeOverrideDirs(overrideDirs)
  // Cline may be installed in any VS Code variant (stable, Insiders, VSCodium),
  // so every globalStorage root is scanned - same as the Roo Code and KiloCode
  // siblings - plus Cline's own home-data root. Shared by discovery and
  // probeRoots so doctor can never report a root discovery does not read.
  const taskRoots = (): string[] => configuredDirs ?? [
    ...clineTaskRoots(EXTENSION_ID),
    getClineDataPath(),
  ]

  return {
    name: 'cline',
    displayName: 'Cline',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return taskRoots().map(path => ({ path, label: 'tasks' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const baseDirs = taskRoots()

      return dedupeTaskSources(await discoverClineTasks(EXTENSION_ID, 'cline', 'Cline', baseDirs))
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createClineParser(source, seenKeys, 'cline')
    },
  }
}

export const cline = createClineProvider()
