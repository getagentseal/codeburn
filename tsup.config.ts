import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/main.ts'],
  format: ['esm'],
  // Keep this below the runtime floor so dist/cli.js can print the upgrade
  // message on older Node before dynamically importing the main bundle.
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
