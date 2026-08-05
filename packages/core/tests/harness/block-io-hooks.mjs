// ESM loader hook (registered by block-io-register.mjs). Throws on resolution of
// any I/O-capable core module, so if @codeburn/core touches the filesystem, a
// child process, or the network at import time — or during any exercised call —
// the import fails and the import-smoke guardrail catches it.
//
// The list is deliberately a superset of the classic fs/child_process/net trio:
// every remaining module Node ships that can reach the ambient machine or its
// network must also be banned, or a decoder could quietly switch escape routes
// (os.homedir(), node:sqlite, a TLS socket, a worker thread, createRequire
// bypassing loader hooks entirely, ...). 'module' is banned because
// createRequire() rebuilds a CJS require that bypasses this resolve hook, and
// module.register() could install a competing hook. 'process' is banned because
// importing it by name is how a module grabs a live handle to the ambient
// environment after the preload has already emptied it.
const BANNED = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'net',
  'http',
  'https',
  'dns',
  'dns/promises',
  // --- ambient machine / network escape routes ---
  'os', // homedir(), tmpdir(), userInfo(), platform()
  'tls', // raw TLS sockets
  'dgram', // UDP sockets
  'http2', // HTTP/2 sockets
  'worker_threads', // a worker can do anything its parent can
  'sqlite', // node:sqlite = direct file access
  'module', // createRequire bypasses loader hooks; register installs hooks
  'process', // live handle to the ambient process/env after they are emptied
])

export async function resolve(specifier, context, nextResolve) {
  const bare = specifier.replace(/^node:/, '')
  if (BANNED.has(bare)) {
    throw new Error(`import-smoke: blocked I/O module import "${specifier}"`)
  }
  return nextResolve(specifier, context)
}
