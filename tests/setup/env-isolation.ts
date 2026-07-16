// Vitest setup file: isolates every test from the developer's shell environment.
//
// codeburn discovers sessions through a long list of provider-specific env
// vars (CLAUDE_CONFIG_DIR, CODEX_HOME, CRUSH_GLOBAL_DATA, …) and via HOME /
// XDG_* / APPDATA / LOCALAPPDATA. Without this file, any value set in the
// developer's shell (e.g. CLAUDE_CONFIG_DIRS=/Users/me/.claude:…) bleeds into
// fixture-based tests: the parser reads the developer's REAL sessions instead
// of the temp-dir fixture, producing nonsense totals and false failures that
// pass on a clean CI runner.
//
// What this file does:
//   1. Mints an empty sandbox temp dir once per worker.
//   2. REDIRECTED vars (HOME / XDG_* / APPDATA / LOCALAPPDATA) point at the
//      sandbox so any fallback to homedir() / platform defaults lands in an
//      empty filesystem.
//   3. CLEARED vars (every provider's explicit override) are deleted so a test
//      that does NOT set one gets "unconfigured" rather than the dev's value.
//   4. PRESERVED vars (PATH, COLUMNS, …) are snapshotted from the dev's shell
//      and restored every test. We can't wipe them - Node uses PATH for spawn
//      and module resolution, terminal code uses COLUMNS - but a test that
//      mutates them shouldn't leak the change into the next test.
//   5. Re-asserts the above before EVERY test (global beforeEach), so a test
//      that mutates an env var doesn't leak its value into the next test.
//      Tests can freely set process.env['HOME'] = customDir without saving the
//      previous value - the next test gets a fresh sandbox baseline.
//
// CAVEAT: env vars set in a test file's beforeAll() get overwritten by this
// file's beforeEach before each test runs. Use beforeEach (not beforeAll) when
// the test body depends on a specific env var value.

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach } from 'vitest'

const sandbox = mkdtempSync(join(tmpdir(), 'codeburn-test-env-'))

const REDIRECTED = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
] as const

const CLEARED = [
  // Provider session-discovery dirs
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIRS',
  'CODEX_HOME',
  'CRUSH_GLOBAL_DATA',
  'CODEBUFF_DATA_DIR',
  'FACTORY_DIR',
  'GOOSE_PATH_ROOT',
  'GROK_HOME',
  'KIRO_HOME',
  'KIMI_SHARE_DIR',
  'MUX_ROOT',
  'OPENCODE_DATA_DIR',
  'OPENCODE_DB_PREFIX',
  'QWEN_DATA_DIR',
  'VIBE_HOME',
  'WARP_DB_PATH',
  'ZS_DATA_DIR',
  // codeburn override dirs / paths
  'CODEBURN_CACHE_DIR',
  'CODEBURN_COPILOT_JETBRAINS_DIR',
  'CODEBURN_COPILOT_OTEL_DB',
  'CODEBURN_COPILOT_SESSION_STATE_DIR',
  'CODEBURN_COPILOT_WS_STORAGE_DIR',
  'CODEBURN_DESKTOP_SESSIONS_DIR',
  'CODEBURN_MUX_DIR',
  'CODEBURN_ANTIGRAVITY_SETTINGS_PATH',
  // codeburn behavior toggles (set by the dev to tweak local runs)
  'CODEBURN_COPILOT_DISABLE_OTEL',
  'CODEBURN_TZ',
  'CODEBURN_VERBOSE',
  'CODEBURN_CURSOR_MAX_BUBBLES',
  'CODEBURN_FORCE_MACOS_MAJOR',
  // Provider model/credential overrides
  'KIMI_MODEL_NAME',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
  // Read by detectBashBloat - a dev's real shell limit must not bleed in
  'BASH_MAX_OUTPUT_LENGTH',
] as const

// Snapshotted from the dev's shell and restored every test. These can't be
// wiped (Node needs PATH for spawn / module resolution, dashboard/table layout
// reads COLUMNS) but a test that mutates them shouldn't leak.
const PRESERVED = ['PATH', 'COLUMNS'] as const
const preservedSnapshot = new Map<string, string | undefined>()
for (const key of PRESERVED) preservedSnapshot.set(key, process.env[key])

function applyIsolation(): void {
  for (const key of REDIRECTED) process.env[key] = sandbox
  for (const key of CLEARED) delete process.env[key]
  for (const key of PRESERVED) {
    const original = preservedSnapshot.get(key)
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  // Pin the timezone so date grouping is deterministic regardless of the dev's
  // shell TZ. Clearing it is not enough (Node falls back to the OS zone); a
  // non-UTC TZ would otherwise shift day buckets versus a clean CI runner. A
  // test that needs a specific zone can still set process.env.TZ in beforeEach.
  process.env.TZ = 'UTC'
}

applyIsolation()
beforeEach(applyIsolation)
