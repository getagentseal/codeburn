import { join, resolve } from 'path'
import { homedir } from 'os'

function normalizeHomeDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed !== 'undefined' && trimmed !== 'null' ? trimmed : undefined
}

export function getOpenClawDirs(): string[] {
  let osHome = normalizeHomeDir(process.env['HOME']) ?? normalizeHomeDir(process.env['USERPROFILE'])
  // OpenClaw also supports Termux when neither conventional home variable is
  // set. A generic PREFIX alone is not enough to select this fallback.
  if (!osHome) {
    const prefix = normalizeHomeDir(process.env['PREFIX'])
    if (prefix && normalizeHomeDir(process.env['ANDROID_DATA'])
      && /(?:^|\/)com\.termux\/files\/usr\/?$/.test(prefix.replace(/\\/g, '/'))) {
      osHome = resolve(prefix, '..', 'home')
    }
  }
  if (!osHome) {
    try {
      osHome = normalizeHomeDir(homedir())
    } catch {
      // OpenClaw's required-home resolver falls back to cwd when the OS
      // lookup cannot provide a home. Apply the same rule without aborting.
    }
  }
  const expandHome = (path: string, home: string): string => resolve(path.replace(/^~(?=$|[\\/])/, () => home))
  // OpenClaw resolves state overrides against its effective home. Trim before
  // expanding so a quoted "~/state" works just like its own path resolver.
  const configuredHome = normalizeHomeDir(process.env['OPENCLAW_HOME'])
  let effectiveHome = configuredHome ?? osHome
  if (configuredHome && /^~(?=$|[\\/])/.test(configuredHome)) {
    // An unresolved tilde override has no effective home. OpenClaw falls back
    // to cwd itself, rather than expanding the remaining suffix under cwd.
    effectiveHome = osHome ? expandHome(configuredHome, osHome) : undefined
  }
  const home = resolve(effectiveHome ?? process.cwd())
  const stateDir = process.env['OPENCLAW_STATE_DIR']?.trim()
  const roots = [
    ...(stateDir ? [join(expandHome(stateDir, home), 'agents')] : []),
    join(home, '.openclaw', 'agents'),
    join(home, '.clawdbot', 'agents'),
    join(home, '.moltbot', 'agents'),
    join(home, '.moldbot', 'agents'),
  ]
  // Keep the historical roots for pre-migration sessions, but scan an override
  // pointing at one of those roots only once (including case aliases on Windows).
  const unique = new Map<string, string>()
  for (const root of roots) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (!unique.has(key)) unique.set(key, root)
  }
  return [...unique.values()]
}
