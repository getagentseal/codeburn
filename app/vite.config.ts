import { execSync } from 'node:child_process'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Build stamp baked in at package/build time so About + the splash footer can
// name the exact commit running. Best-effort: a non-git checkout still builds.
function buildStamp(): { sha: string; date: string } {
  let sha = 'unknown'
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'unknown'
    // A build off a dirty tree (local fix build) must never read as the clean
    // release of the same commit — that ambiguity is exactly what a build stamp
    // exists to kill.
    if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) sha += '-dirty'
  } catch { /* not a git checkout */ }
  return { sha, date: new Date().toISOString().slice(0, 10) }
}
const stamp = buildStamp()

// The production index.html ships a strict `script-src 'self'`. In dev, Vite's
// React Fast Refresh preamble is injected as an inline <script>, which that CSP
// blocks; relax script-src to allow inline scripts for the dev server only.
function devCsp(): Plugin {
  return {
    name: 'codeburn-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    },
  }
}

// Renderer-only Vite config. The Electron main/preload are compiled separately
// by tsconfig.electron.json. `base: './'` so the built index.html loads its
// assets over file:// in production.
export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react(), devCsp()],
  define: {
    __BUILD_SHA__: JSON.stringify(stamp.sha),
    __BUILD_DATE__: JSON.stringify(stamp.date),
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: '../dist/renderer', emptyOutDir: true },
})
