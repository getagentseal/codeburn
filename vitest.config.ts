import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // C9: bench files excluded from default test run (only via `npx vitest bench`)
    exclude: ['node_modules', 'dist', 'tests/bench/**'],
  },
})
