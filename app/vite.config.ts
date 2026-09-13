import { execSync } from 'node:child_process'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

import { isDirtyIgnoringGenerated } from './scripts/buildStamp'

// Build stamp baked in at package/build time so the About modal can name the
// exact commit running. Best-effort: a non-git checkout still builds.
function buildStamp(): { sha: string; date: string } {
  let sha = 'unknown'
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'unknown'
    // A build off a dirty tree (local fix build) must never read as the clean
    // release of the same commit — that ambiguity is exactly what a build stamp
    // exists to kill. But packaging regenerates the pricing snapshots mid-build,
    // so ignore those: a change limited to them is not a dirty source tree.
    if (isDirtyIgnoringGenerated(execSync('git status --porcelain', { encoding: 'utf8' }))) sha += '-dirty'
  } catch { /* not a git checkout */ }
  return { sha, date: new Date().toISOString().slice(0, 10) }
}
const stamp = buildStamp()

// The production index.html ships a strict `script-src 'self'`. In dev, Vite's
// React Fast Refresh preamble is injected as an inline <script>, which that CSP
// blocks; relax script-src to allow inline scripts for the dev server only.
//
// CODEBURN_DEMO_BRIDGE=1 additionally opts this dev server into the repo's
// browser-demo harness (app/demo-bridge.mjs): it loads renderer/public's
// demo-shim.js BEFORE the app bundle (plain scripts run at parse time; module
// scripts are deferred) and widens connect-src to the bridge's 127.0.0.1:4900.
// The shipped index.html and production CSP are untouched.
function devCsp(): Plugin {
  const demo = process.env.CODEBURN_DEMO_BRIDGE === '1'
  return {
    name: 'codeburn-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      let out = html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      if (demo) {
        out = out.replace(
          "connect-src 'self' ws://localhost:5173 http://localhost:5173",
          "connect-src 'self' ws://localhost:5173 http://localhost:5173 http://127.0.0.1:4900",
        )
        out = out.replace(
          '<div id="root"></div>',
          '<div id="root"></div>\n    <script src="/demo-shim.js"></script>',
        )
      }
      return out
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
  // CODEBURN_DEV_PORT lets parallel checkouts dev on distinct ports (default
  // 5173 unchanged). strictPort keeps a misconfigured overlap loud instead of
  // silently hopping to a port the Electron dev script would never watch.
  server: {
    host: '127.0.0.1',
    port: Number.parseInt(process.env.CODEBURN_DEV_PORT ?? '5173', 10) || 5173,
    strictPort: true,
  },
  build: { outDir: '../dist/renderer', emptyOutDir: true },
})
