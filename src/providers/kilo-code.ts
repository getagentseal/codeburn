import { discoverClineTasks, createClineParser } from './vscode-cline-parser.js'
import type { Provider, SessionSource, SessionParser } from './types.js'

const EXTENSION_ID = 'kilocode.kilo-code'

export function createKiloCodeProvider(overrideDir?: string | string[]): Provider {
  return {
    name: 'kilo-code',
    displayName: 'KiloCode',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverClineTasks(EXTENSION_ID, 'kilo-code', 'KiloCode', overrideDir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createClineParser(source, seenKeys, 'kilo-code')
    },
  }
}

export const kiloCode = createKiloCodeProvider()
