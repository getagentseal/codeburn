import { stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { decodeVscodeCline } from '@codeburn/core/providers/vscode-cline'
import type { VscodeClineDecodedCall } from '@codeburn/core/providers/vscode-cline'

import { createBridgedProvider } from './bridge.js'
import { discoverClineTasks, getVSCodeGlobalStoragePaths, readClineRecords, toClineProviderCall } from './vscode-cline-parser.js'
import type { Provider, SessionSource } from './types.js'

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

  return createBridgedProvider<VscodeClineDecodedCall>({
    name: 'cline',
    displayName: 'Cline',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      // Cline may be installed in any VS Code variant (stable, Insiders,
      // VSCodium), so every globalStorage root is scanned - same as the Roo Code
      // and KiloCode siblings - plus Cline's own home-data root.
      const baseDirs = configuredDirs ?? [
        ...getVSCodeGlobalStoragePaths(EXTENSION_ID),
        getClineDataPath(),
      ]

      return dedupeTaskSources(await discoverClineTasks(EXTENSION_ID, 'cline', 'Cline', baseDirs))
    },

    readRecords: readClineRecords,
    decode: input => decodeVscodeCline(input),
    toProviderCall: toClineProviderCall,
  })
}

export const cline = createClineProvider()
