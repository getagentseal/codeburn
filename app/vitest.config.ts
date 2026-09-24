import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Default env is node (for electron/cli tests). Renderer component tests opt
// into jsdom with a `// @vitest-environment jsdom` docblock.
// Node 25 turned the built-in localStorage on by default, and it shadows jsdom's:
// the renderer tests that use it fail with "--localstorage-file was not provided".
// The flag has existed since Node 22.4 but not before it, so it is passed only
// when this Node admits it — an unknown flag would stop the worker from starting.
const execArgv = process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : []

export default defineConfig({
  plugins: [react()],
  test: {
    poolOptions: { forks: { execArgv }, threads: { execArgv } },
    environment: 'node',
    // Node's --localstorage-file backs localStorage with one file shared by every
    // worker, so parallel files clobber each other's keys via the afterEach clear
    // in setup.ts. Run files sequentially to keep localStorage isolated per file.
    fileParallelism: false,
    env: { CODEBURN_APP_FILTER: '' },
    globals: false,
    setupFiles: ['./renderer/test/setup.ts'],
    include: ['renderer/**/*.test.{ts,tsx}', 'electron/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
