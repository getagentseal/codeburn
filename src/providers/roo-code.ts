import { discoverClineTasks, createClineParser } from './vscode-cline-parser.js'
import type { Provider, SessionSource, SessionParser } from './types.js'

const EXTENSION_ID = 'rooveterinaryinc.roo-cline'

export function createRooCodeProvider(overrideDir?: string | string[]): Provider {
  return {
    name: 'roo-code',
    displayName: 'Roo Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverClineTasks(EXTENSION_ID, 'roo-code', 'Roo Code', overrideDir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createClineParser(source, seenKeys, 'roo-code')
    },
  }
}

export const rooCode = createRooCodeProvider()
