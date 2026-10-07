// Headless smoke test: installs nothing, launches a throwaway editor with the
// extension loaded from this folder against a fixture home, and runs suite.cjs.
//
//   npm run test:smoke                     downloads VS Code stable (CI: under xvfb-run)
//   CODEBURN_SMOKE_APP=/Applications/Visual\ Studio\ Code.app npm run test:smoke
//                                          macOS: an installed editor (or Cursor.app), launched hidden
//
// Needs `npm run build` first (dist/ and cli/).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extensionPath = join(here, '..', '..')
const launch = join(extensionPath, 'cli', 'dist', 'launch.js')
if (!existsSync(launch) || !existsSync(join(extensionPath, 'dist', 'extension.js'))) {
  throw new Error('smoke: build the extension first (npm run build)')
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'codeburn-smoke-')))
const home = join(tmp, 'home')
const workspace = join(tmp, 'smoke-app')
const other = join(tmp, 'other-app')
for (const dir of [home, workspace, other]) mkdirSync(dir, { recursive: true })

/** One Claude Code session started in `cwd`, a few minutes ago. */
function session(cwd, id, output) {
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
  const lines = [
    { type: 'user', uuid: `${id}-u`, sessionId: id, cwd, timestamp: at(6), message: { role: 'user', content: 'Add a test' } },
    {
      type: 'assistant', uuid: `${id}-a`, parentUuid: `${id}-u`, sessionId: id, cwd, timestamp: at(5),
      message: {
        id: `${id}-m`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 20_000, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ]
  writeFileSync(join(dir, `${id}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}
session(workspace, 'smoke-ws', 4_000)
session(other, 'smoke-other', 40_000)

const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  CODEBURN_APP_FILTER: '',
}
const costOf = (...extra) => {
  const out = execFileSync(process.execPath, [launch, 'status', '--format', 'menubar-json', '--period', 'today', '--no-optimize', ...extra], { env, encoding: 'utf8' })
  return JSON.parse(out).current.cost
}
const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const today = costOf()
const workspaceToday = costOf(`--project=${workspace}`)
if (!(today > workspaceToday && workspaceToday > 0)) throw new Error(`smoke: fixture costs look wrong (all ${today}, workspace ${workspaceToday})`)

const out = join(tmp, 'results.json')
const testEnv = {
  ...env,
  CODEBURN_SMOKE_OUT: out,
  CODEBURN_SMOKE_TODAY_LINE: `Today: ${usd(today)}`,
  CODEBURN_SMOKE_WORKSPACE_LINE: `${basename(workspace)}: ${usd(workspaceToday)}`,
}
const launchArgs = [
  workspace,
  '--disable-extensions', '--locale', 'en', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  `--user-data-dir=${join(tmp, 'user-data')}`, `--extensions-dir=${join(tmp, 'extensions')}`,
]
// Cursor 3 opens its Agents window on a fresh profile, which starts no extension host.
if (/cursor/i.test(process.env.CODEBURN_SMOKE_APP ?? '')) launchArgs.unshift('--classic')
const suite = join(here, 'suite.cjs')
// No quota checks: they would reach provider APIs, and Claude's can ask for the macOS keychain.
mkdirSync(join(tmp, 'user-data', 'User'), { recursive: true })
writeFileSync(join(tmp, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'codeburn.quotaProviders': [] }))

let code = 1
try {
  if (process.env.CODEBURN_SMOKE_APP) {
    // A hidden, separate instance (its own user data dir) so nothing appears on screen.
    const args = ['-W', '-n', '-j', '-g', ...Object.entries(testEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '-a', process.env.CODEBURN_SMOKE_APP, '--args',
      ...launchArgs, `--extensionDevelopmentPath=${extensionPath}`, `--extensionTestsPath=${suite}`]
    spawnSync('open', args, { stdio: 'inherit', timeout: 5 * 60_000 })
  } else {
    const { runTests } = await import('@vscode/test-electron')
    await runTests({ extensionDevelopmentPath: extensionPath, extensionTestsPath: suite, launchArgs, extensionTestsEnv: testEnv })
  }
  const results = JSON.parse(readFileSync(out, 'utf8'))
  // deactivate() stops the serve child and removes its pid file once the editor closes.
  const storage = join(tmp, 'user-data', 'User', 'globalStorage', 'codeburn.codeburn')
  const leftover = existsSync(storage) ? readdirSync(storage).filter(name => /^serve-\d+\.pid$/.test(name)) : []
  results.push({ name: 'removes its serve pid file on exit', ok: leftover.length === 0, ...(leftover.length ? { error: leftover.join(', ') } : {}) })
  for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.text ? `\n${result.text.replace(/^/gm, '     ')}` : ''}${result.error ? `\n     ${result.error}` : ''}`)
  code = results.every(result => result.ok) ? 0 : 1
} catch (error) {
  console.error(error)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(code)
