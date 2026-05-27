import { join } from 'path'
import { homedir } from 'os'

import { discoverClineTasks, createClineParser } from './vscode-cline-parser.js'
import { discoverSqliteSessions, createSqliteSessionParser, type SqliteProviderConfig } from './sqlite-session-parser.js'
import type { Provider, SessionSource, SessionParser } from './types.js'

const EXTENSION_ID = 'kilocode.kilo-code'
const PROVIDER_NAME = 'kilo-code'

function getSqliteConfig(): SqliteProviderConfig {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return {
    providerName: PROVIDER_NAME,
    displayName: 'KiloCode',
    dbDir: join(base, 'kilo'),
    dbFilePrefix: 'kilo',
  }
}

export function createKiloCodeProvider(overrideDir?: string | string[]): Provider {
  const sqliteConfig = getSqliteConfig()

  return {
    name: PROVIDER_NAME,
    displayName: 'KiloCode',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (overrideDir !== undefined) {
        return discoverClineTasks(EXTENSION_ID, PROVIDER_NAME, 'KiloCode', overrideDir)
      }

      const [oldSessions, dbSessions] = await Promise.all([
        discoverClineTasks(EXTENSION_ID, PROVIDER_NAME, 'KiloCode'),
        discoverSqliteSessions(sqliteConfig),
      ])
      return [...oldSessions, ...dbSessions]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      if (source.path.includes('.db:')) {
        return createSqliteSessionParser(source, seenKeys, sqliteConfig)
      }
      return createClineParser(source, seenKeys, PROVIDER_NAME)
    },
  }
}

export const kiloCode = createKiloCodeProvider()
