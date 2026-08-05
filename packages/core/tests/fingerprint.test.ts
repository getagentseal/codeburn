import { describe, expect, it } from 'vitest'

import {
  branchRef,
  classifyResource,
  commandFamily,
  junkSegmentOf,
  normalizePath,
  projectRef,
  resourceFingerprint,
  sessionRef,
} from '../src/fingerprint.js'

const KEY = 'test-privacy-key'
const KEY2 = 'a-different-key'
const HEX16 = /^[0-9a-f]{16}$/

describe('fingerprint shape', () => {
  it('every ref is 16 lowercase hex chars', () => {
    expect(sessionRef(KEY, 'claude', 's1')).toMatch(HEX16)
    expect(projectRef(KEY, '/home/u/proj')).toMatch(HEX16)
    expect(branchRef(KEY, 'feature/x')).toMatch(HEX16)
    expect(resourceFingerprint(KEY, '/home/u/proj/src/a.ts').resourceId).toMatch(HEX16)
  })

  it('requires a privacy key', () => {
    expect(() => sessionRef('', 'claude', 's1')).toThrow(/privacyKey/)
  })
})

describe('determinism', () => {
  it('same inputs + key produce the same ref', () => {
    expect(sessionRef(KEY, 'claude', 's1')).toBe(sessionRef(KEY, 'claude', 's1'))
    expect(projectRef(KEY, '/home/u/proj')).toBe(projectRef(KEY, '/home/u/proj'))
    expect(branchRef(KEY, 'main')).toBe(branchRef(KEY, 'main'))
  })
})

describe('distinctness', () => {
  it('different inputs produce different refs', () => {
    expect(sessionRef(KEY, 'claude', 's1')).not.toBe(sessionRef(KEY, 'claude', 's2'))
    expect(projectRef(KEY, '/a')).not.toBe(projectRef(KEY, '/b'))
  })

  it('a different key produces a different ref (key isolation)', () => {
    expect(sessionRef(KEY, 'claude', 's1')).not.toBe(sessionRef(KEY2, 'claude', 's1'))
  })
})

describe('domain separation', () => {
  it('the same string in different domains produces different refs', () => {
    const s = 'shared-string'
    const asSession = sessionRef(KEY, s, '') // session-domain
    const asProject = projectRef(KEY, s)
    const asBranch = branchRef(KEY, s)
    const asResource = resourceFingerprint(KEY, s).resourceId
    const all = new Set([asSession, asProject, asBranch, asResource])
    expect(all.size).toBe(4)
  })

  it('sessionRef separates provider from id (no field-boundary collision)', () => {
    // "ab" + "c" must not collide with "a" + "bc".
    expect(sessionRef(KEY, 'ab', 'c')).not.toBe(sessionRef(KEY, 'a', 'bc'))
  })
})

describe('non-reversibility (sanity)', () => {
  it('the ref does not contain the plaintext input', () => {
    const secret = 'super-secret-session-id'
    const ref = sessionRef(KEY, 'claude', secret)
    expect(ref).not.toContain(secret)
    expect(ref.length).toBe(16)
  })
})

describe('path normalization', () => {
  it('converts backslashes and strips trailing separators', () => {
    expect(normalizePath('C:\\Users\\me\\proj\\')).toBe('c:/users/me/proj')
    expect(normalizePath('/home/u/proj/')).toBe('/home/u/proj')
  })

  it('case-folds only Windows-style paths', () => {
    // POSIX path keeps case (Foo.ts !== foo.ts on POSIX).
    expect(normalizePath('/home/U/Foo.ts')).toBe('/home/U/Foo.ts')
    // Windows drive path is lowercased.
    expect(normalizePath('D:\\Code\\App.TS')).toBe('d:/code/app.ts')
  })

  it('a POSIX and Windows spelling of the same path can be made to hash equally when case matches', () => {
    // Backslash form is treated as Windows and lowercased; the equivalent
    // already-lowercase POSIX form hashes identically.
    expect(projectRef(KEY, 'C:\\proj\\app')).toBe(projectRef(KEY, 'c:/proj/app'))
  })
})

describe('resource classification', () => {
  const cases: Array<[string, string]> = [
    ['/repo/node_modules/lodash/index.js', 'dependency'],
    ['/repo/.venv/lib/site.py', 'dependency'],
    ['/repo/venv/lib/site.py', 'dependency'],
    ['/repo/backend/site-packages/x.py', 'dependency'],
    ['/repo/dist/index.js', 'build'],
    ['/repo/.next/server/page.js', 'build'],
    ['/repo/.nuxt/dist/app.js', 'build'],
    ['/repo/.output/server/index.mjs', 'build'],
    ['/repo/target/debug/app', 'build'],
    ['/repo/pkg/__pycache__/mod.cpython-312.pyc', 'build'],
    ['/repo/coverage/lcov.info', 'build'],
    ['/repo/.cache/webpack/index.pack', 'build'],
    ['/repo/.git/HEAD', 'vcs'],
    ['/repo/.svn/entries', 'vcs'],
    ['/repo/.hg/store/data.i', 'vcs'],
    ['/repo/.eslintrc', 'config'],
    ['/repo/tsconfig.json', 'config'],
    ['/repo/config/app.yaml', 'config'],
    ['/repo/Cargo.toml', 'config'],
    ['/repo/README.md', 'doc'],
    ['/repo/notes.txt', 'doc'],
    ['/repo/src/main.ts', 'source'],
    ['/repo/src/lib.rs', 'source'],
    ['/repo/pkg/service.go', 'source'],
    ['/repo/data.bin', 'other'],
    ['/repo/LICENSE', 'other'],
  ]
  it.each(cases)('classifies %s as %s', (path, expected) => {
    expect(classifyResource(path)).toBe(expected)
  })

  it('directory class beats extension (a .ts under node_modules is a dependency)', () => {
    expect(classifyResource('/repo/node_modules/pkg/index.ts')).toBe('dependency')
  })
})

describe('junkSegmentOf', () => {
  it('returns the exact segment that made the path junk', () => {
    expect(junkSegmentOf('/repo/node_modules/lodash/index.js')).toBe('node_modules')
    expect(junkSegmentOf('/go/src/app/vendor/lib.go')).toBe('vendor')
    expect(junkSegmentOf('/py/.venv/lib/site.py')).toBe('.venv')
    expect(junkSegmentOf('/py/venv/lib/site.py')).toBe('venv')
    expect(junkSegmentOf('/py/site-packages/x.py')).toBe('site-packages')
    expect(junkSegmentOf('/repo/dist/index.js')).toBe('dist')
    expect(junkSegmentOf('/rs/target/debug/app')).toBe('target')
    expect(junkSegmentOf('/repo/.next/server/page.js')).toBe('.next')
    expect(junkSegmentOf('/repo/.git/HEAD')).toBe('.git')
  })

  it('follows classifyResource precedence (dependency > build > vcs)', () => {
    // The segment returned must be the one that determined the class.
    expect(junkSegmentOf('/a/vendor/b/out/c')).toBe('vendor')
    expect(junkSegmentOf('/a/out/b/.git/c')).toBe('out')
  })

  it('returns null for non-junk paths, including .tsbuildinfo files', () => {
    expect(junkSegmentOf('/repo/src/a.ts')).toBeNull()
    expect(junkSegmentOf('/repo/README.md')).toBeNull()
    // '.tsbuildinfo' names a file (tsconfig.tsbuildinfo), never a directory
    // segment, so it is deliberately not junk (see junk-reads detector notes).
    expect(junkSegmentOf('/repo/foo.tsbuildinfo')).toBeNull()
  })
})

describe('commandFamily (leading token only)', () => {
  const cases: Array<[string, string]> = [
    ['git commit -m "x"', 'git'],
    ['git push origin main', 'git'],
    ['vitest run tests/', 'test'],
    ['pytest -q', 'test'],
    ['npm test', 'test'],
    ['npm run build', 'build'],
    ['npm run dev', 'run'],
    ['npm install lodash', 'package'],
    ['yarn add react', 'package'],
    ['pnpm ci', 'package'],
    ['tsc --noEmit', 'build'],
    ['make all', 'build'],
    ['go test ./...', 'test'],
    ['go build ./cmd', 'build'],
    ['pip install requests', 'package'],
    ['node server.js', 'run'],
    ['python3 main.py', 'run'],
    ['./scripts/run.sh', 'run'],
    ['/usr/local/bin/tool --flag', 'run'],
    ['rm -rf build', 'fs'],
    ['ls -la', 'fs'],
    ['curl https://example.com', 'net'],
    ['ssh host', 'net'],
    ['frobnicate --wild', 'shell-other'],
    ['', 'shell-other'],
  ]
  it.each(cases)('classifies %j as %s', (command, expected) => {
    expect(commandFamily(command)).toBe(expected)
  })

  it('classifies by the binary basename, not its path', () => {
    expect(commandFamily('/opt/homebrew/bin/git status')).toBe('git')
  })
})
