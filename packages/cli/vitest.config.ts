import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runs once per worker before any test. Scrubs the developer's shell so
    // session-discovery env vars (CLAUDE_CONFIG_DIRS, HOME, XDG_*, every
    // provider-specific *_HOME) don't bleed real local data into fixtures.
    setupFiles: ['./tests/setup/env-isolation.ts'],
    // A handful of integration tests exercise real servers, spawned CLI
    // subprocesses and real filesystem locks. Under a saturated full-suite run
    // an fs/socket op can starve and the operation fails closed (correct, but
    // an environmental blip, not a logic error), so a different one trips each
    // run. A small retry rides out that starvation; a real regression is
    // deterministic and fails every attempt. Tests that need more headroom set
    // a higher retry locally (it overrides this).
    retry: 2,
  },
})
