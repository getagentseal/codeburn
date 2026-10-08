#!/usr/bin/env node
// This launcher must stay parseable by Node 18. Do NOT add static imports.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `codeburn requires Node.js >= 22.13.0 (current: ${process.version})\n` +
    'Upgrade at https://nodejs.org/\n',
  )
  process.exit(1)
}

// React (loaded by Ink) picks its development build unless NODE_ENV is exactly
// "production". That build records a performance.measure() entry on every
// render into Node's user-timing buffer, which nothing ever trims, so an
// interactive dashboard left open for days grows until V8 aborts with
// "JavaScript heap out of memory". Default to the production build; an
// explicit NODE_ENV in the shell still wins. This must run before main.js is
// imported because React reads NODE_ENV at module load.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'

import('./main.js').catch((err) => {
  process.stderr.write(String(err?.message ?? err) + '\n')
  process.exit(1)
})
