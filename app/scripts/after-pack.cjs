// Copy the staged self-contained CLI (app/build/cli, produced by stage-cli.mjs)
// into the packaged app's resources/cli directory.
//
// This is done here rather than via `extraResources` because electron-builder
// routes every `node_modules` directory it copies through its production-
// dependency filter, which keeps only the *app's* own deps — so the bundled
// CLI's dependency tree gets stripped out of an `extraResources` copy. afterPack
// runs after packaging but before code signing, so the files we add land inside
// the app's signature. The CLI's deps are pure JS (no native bindings), so the
// same tree is valid for every arch.

const { join } = require('node:path')
const { cpSync, existsSync, writeFileSync } = require('node:fs')

// A codeburn the menubar can run straight out of the bundle, so a desktop-only install has one
// even when nothing was recorded for it (#1825). It finds its own bundle, so ~/Applications works.
function writeMacCliLauncher(cliDir, executableName) {
  writeFileSync(join(cliDir, 'codeburn'), [
    '#!/bin/sh',
    'here=$(cd "$(dirname "$0")" && pwd -P)',
    `ELECTRON_RUN_AS_NODE=1 exec "$here/../../MacOS/${executableName}" "$here/dist/launch.js" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
}

exports.writeMacCliLauncher = writeMacCliLauncher

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const src = join(__dirname, '..', 'build', 'cli')
  if (!existsSync(join(src, 'node_modules'))) {
    throw new Error(`after-pack: ${src}/node_modules is missing — run "npm run stage-cli" first`)
  }

  const resources =
    electronPlatformName === 'darwin'
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources')
  const dest = join(resources, 'cli')

  cpSync(src, dest, { recursive: true, dereference: true })
  if (electronPlatformName === 'darwin') writeMacCliLauncher(dest, packager.appInfo.productFilename)
  console.log(`after-pack: bundled CLI copied -> ${dest}`)
}
