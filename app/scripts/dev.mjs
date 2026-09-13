#!/usr/bin/env node
// Dev launcher for the Electron app. Wraps the previous inline `dev` npm
// script; the only addition is that the Vite port can be overridden with
// CODEBURN_DEV_PORT (default 5173, unchanged), so parallel checkouts each get
// a private Vite + VITE_DEV_SERVER_URL pair without touching anyone else's
// server. Cross-platform by construction (no shell ${VAR} expansion).
//
// Contract for integration (goal-7): if this launcher gains options later,
// keep CODEBURN_DEV_PORT the single source of the port and keep passing the
// same VITE_DEV_SERVER_URL to Electron; the app itself reads only that env var.
import { spawn } from 'node:child_process'

const port = String(Number.parseInt(process.env.CODEBURN_DEV_PORT ?? '5173', 10) || 5173)
const devUrl = `http://127.0.0.1:${port}`
const shell = process.platform === 'win32'

let exiting = false
const children = []

function shutdown(code) {
  if (exiting) return
  exiting = true
  for (const child of children) {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function watch(child) {
  children.push(child)
  child.on('error', err => {
    console.error('dev: failed to start:', err.message)
    shutdown(1)
  })
  // Mirror concurrently's -k: when either side exits, take the other down too.
  child.on('exit', code => shutdown(code ?? 0))
  return child
}

watch(spawn('npx', ['vite'], { stdio: 'inherit', shell, env: process.env }))

// Wait for Vite's port, then start Electron pointed at the same dev URL.
const waiter = spawn('npx', ['wait-on', `tcp:127.0.0.1:${port}`], { stdio: 'inherit', shell, env: process.env })
waiter.on('error', err => {
  console.error('dev: wait-on failed to start:', err.message)
  shutdown(1)
})
waiter.on('exit', code => {
  if (exiting) return
  if (code !== 0) {
    shutdown(code ?? 1)
    return
  }
  watch(spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    shell,
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
  }))
})
