// Preload (`node --import`) for the import-smoke child. Registers the I/O
// blocking loader hook, removes the network globals, and neutralizes the
// ambient environment so the child runs with no way to reach fs / child_process
// / net / http / https / dns / os / tls / dgram / http2 / worker_threads /
// sqlite / createRequire — and no ambient env to read.
import { register } from 'node:module'

register('./block-io-hooks.mjs', import.meta.url)

// The ambient environment is emptied, and env reads of keys that HAD a value
// throw. Why throw at all, instead of plain emptying? An emptied env makes
// `process.env.HOME` return undefined silently — a read succeeds and the guard
// never notices. We verified a fully-throwing proxy is NOT viable: Node's own
// ESM loader reads process.env lazily during module linking (e.g.
// WATCH_REPORT_DEPENDENCIES on node 26), so a blanket `get` trap breaks Node
// itself, not just dependencies. The narrow variant below keeps Node's
// internal reads of *unset* keys harmless (undefined) while making any read of
// a key that genuinely had an ambient value (HOME, PATH, NODE_ENV, tokens...)
// fail loudly. Core's entire runtime graph is zod + node:crypto, neither of
// which reads ambient env at import, so this is safe today and catches the
// first accidental `process.env.*` read a future decoder adds.
const ambientKeys = new Set(Object.keys(process.env))
for (const key of Object.keys(process.env)) {
  delete process.env[key]
}
process.env = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (ambientKeys.has(String(prop))) {
        throw new Error(`import-smoke: blocked ambient env read "${String(prop)}"`)
      }
      return undefined
    },
    has(_target, prop) {
      return ambientKeys.has(String(prop))
    },
    set() {
      return true
    },
    deleteProperty() {
      return true
    },
    ownKeys() {
      return []
    },
    getOwnPropertyDescriptor() {
      return undefined
    },
  },
)

// Network globals: undici's fetch (and the WebSocket global) are how a module
// reaches the network without importing any `node:` module at all.
delete globalThis.fetch
delete globalThis.WebSocket
