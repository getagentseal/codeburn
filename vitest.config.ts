import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runs once per worker before any test. Scrubs the developer's shell so
    // session-discovery env vars (CLAUDE_CONFIG_DIRS, HOME, XDG_*, every
    // provider-specific *_HOME) don't bleed real local data into fixtures.
    setupFiles: ['./tests/setup/env-isolation.ts'],
  },
})
