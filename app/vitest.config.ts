import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Default env is node (for electron/cli tests). Renderer component tests opt
// into jsdom with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./renderer/test/setup.ts'],
    include: ['renderer/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
  },
})
