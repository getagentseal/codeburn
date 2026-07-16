import { join } from 'path'
import { homedir } from 'os'

import { getShortModelName } from '../models.js'
import { discoverSqliteSessions, createSqliteSessionParser, type SqliteProviderConfig } from './sqlite-session-parser.js'
import { discoverOpenCodeFileSessions, createOpenCodeFileSessionParser } from './opencode-file-parser.js'
import type { Provider, SessionSource, SessionParser } from './types.js'

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

function getDataDir(dataDir?: string): string {
  // Test seam: createOpenCodeProvider(tmpDir) points at a base dir that still
  // gets the 'opencode' subdirectory appended, preserving existing fixtures
  // (tmpDir/opencode/opencode*.db and tmpDir/opencode/storage/...).
  if (dataDir) return join(dataDir, 'opencode')

  // Production override for OpenCode-compatible forks/renames (e.g. MiMoCode at
  // ~/.local/share/mimocode). This is the EXACT data directory — no 'opencode'
  // suffix — so a fork writing <dir>/<prefix>*.db or <dir>/storage/... is found
  // instead of silently yielding zero sessions. (issue #617)
  const override = process.env['OPENCODE_DATA_DIR']
  if (override) return override

  // Default: $XDG_DATA_HOME/opencode or ~/.local/share/opencode.
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'opencode')
}

function getSqliteConfig(dataDir?: string): SqliteProviderConfig {
  return {
    providerName: 'opencode',
    displayName: 'OpenCode',
    dbDir: getDataDir(dataDir),
    // Truthy check (not `??`): an empty-string `OPENCODE_DB_PREFIX` must fall
    // back to 'opencode'. With `??`, '' survives as the prefix and
    // `discoverSqliteSessions` matches every '*.db' file (filename.startsWith('')
    // is always true), sweeping unrelated DBs into discovery. Aligns with
    // `OPENCODE_DATA_DIR`'s truthy handling above, and makes behavior identical
    // for unset vs empty — which matches the env fingerprint, since
    // `computeEnvFingerprint` collapses both to 'OPENCODE_DB_PREFIX='. (issue #617)
    dbFilePrefix: process.env['OPENCODE_DB_PREFIX'] || 'opencode',
  }
}

export function createOpenCodeProvider(dataDir?: string): Provider {
  const sqliteConfig = getSqliteConfig(dataDir)
  const resolvedDataDir = getDataDir(dataDir)

  return {
    name: 'opencode',
    displayName: 'OpenCode',

    modelDisplayName(model: string): string {
      const stripped = model.replace(/^[^/]+\//, '')
      return getShortModelName(stripped)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    // OpenCode migrated from file-based JSON (storage/session/*.json) to a
    // SQLite DB (opencode.db). After an in-place upgrade, legacy JSON files
    // remain on disk while all new data flows into the SQLite DB. Merge both
    // sources so migrated installs keep reporting legacy sessions AND pick up
    // current SQLite data. Dedup is handled per-message in createSessionParser
    // via seenKeys (keyed by `${provider}:${sessionId}:${messageId}`).
    async discoverSessions(): Promise<SessionSource[]> {
      const fileSessions = await discoverOpenCodeFileSessions(resolvedDataDir, 'opencode')
      const sqliteSessions = await discoverSqliteSessions(sqliteConfig)
      return [...fileSessions, ...sqliteSessions]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      if (source.path.endsWith('.json')) {
        return createOpenCodeFileSessionParser(source, seenKeys, resolvedDataDir, 'opencode')
      }
      return createSqliteSessionParser(source, seenKeys, sqliteConfig)
    },
  }
}

export const opencode = createOpenCodeProvider()
