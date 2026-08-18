// Guard for issue #1011: the Flatpak sandbox must never hand the app
// read-write access to the whole home directory again, and the set of
// writable grants must stay small enough that adding to it is a decision
// somebody makes on purpose.
//
// This deliberately does NOT check the read grant against a list of provider
// directories. That approach was tried and dropped: CodeBurn also reads the
// user's arbitrary project directories (git attribution, CLAUDE.md, per-project
// MCP config), which no enumeration can cover, and any provider root missing
// from such a list fails as ENOENT — indistinguishable from "tool not
// installed". `home:ro` covers both, and read-only is the property worth
// pinning.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'app', 'flathub', 'org.agentseal.CodeBurn.yaml')

// Writable grants, each with the reason it exists. Adding one means editing
// this map, which is the point.
const ALLOWED_WRITABLE: Record<string, string> = {
  '~/.config/codeburn': 'CodeBurn owns this: config.json, act journal, sharing store, sync credentials',
  'xdg-download': '`codeburn export` needs a real destination; under home:ro it would write to the sandbox tmpfs',
}

function filesystemGrants(): string[] {
  const manifest = readFileSync(MANIFEST, 'utf8')
  const grants: string[] = []
  for (const raw of manifest.split('\n')) {
    const line = raw.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '')
    if (line.startsWith('--filesystem=')) grants.push(line.slice('--filesystem='.length))
  }
  return grants
}

// A grant is writable unless it carries an explicit :ro suffix.
function isWritable(grant: string): boolean {
  return !grant.endsWith(':ro')
}

function pathOf(grant: string): string {
  return grant.replace(/:(ro|rw|create)$/, '')
}

describe('Flatpak sandbox grants (#1011)', () => {
  it('never grants a writable home directory', () => {
    const writableHome = filesystemGrants().filter(g => {
      const p = pathOf(g)
      return isWritable(g) && (p === 'home' || p === '~' || p === '~/' || p === 'host')
    })
    expect(
      writableHome,
      `The Flatpak manifest grants write access to the whole home: ${writableHome.join(', ')}. `
      + 'CodeBurn only reads session logs and project directories — use home:ro.',
    ).toEqual([])
  })

  it('reads the home directory, so no provider or project directory can go missing', () => {
    expect(filesystemGrants()).toContain('home:ro')
  })

  it('keeps every writable grant declared and justified', () => {
    const undeclared = filesystemGrants()
      .filter(isWritable)
      .map(pathOf)
      .filter(p => !(p in ALLOWED_WRITABLE))
    expect(
      undeclared,
      `Undeclared writable Flatpak grant(s): ${undeclared.join(', ')}. `
      + 'Add an entry to ALLOWED_WRITABLE in this test with the reason, or make the grant :ro.',
    ).toEqual([])
  })

  it('fills the cache and OpenCode paths without clobbering a user value', () => {
    const manifest = readFileSync(MANIFEST, 'utf8')
    // `:+` so an empty value is refilled: getCodeburnCacheDir and opencode's
    // getDataDir both treat empty as unset.
    expect(manifest).toContain('if [ -z "${CODEBURN_CACHE_DIR:+x}" ]; then')
    expect(manifest).toContain('if [ -z "${OPENCODE_DATA_DIR:+x}" ]; then')
    // XDG_CACHE_HOME needs its own default, or an unset value makes the cache
    // directory the literal "/codeburn".
    expect(manifest).toContain('${XDG_CACHE_HOME:-$HOME/.cache}/codeburn')
  })
})
