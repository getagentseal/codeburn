import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { matchesProjectPattern } from '../src/parser.js'

import { projectMatches, projectPattern } from '../app/renderer/lib/projectMatch.js'

const PROJECTS = [
  { name: 'my-company', path: '/Users/me/work/my-company' },
  { name: 'my-company-kit', path: '/Users/me/work/my-company-kit' },
  { name: 'client', path: '/Users/me/work/my-company/packages/client' },
  { name: 'Vault', path: '/a/Vault' },
  { name: 'vault', path: '/a/vault' },
  { name: 'win', path: 'C:\\Work\\Vault' },
  { name: 'unc', path: '\\\\Server\\Share\\Vault' },
  { name: 'stripped', path: 'root/vault' },
  { name: 'stripped-ui', path: 'root/vault-ui' },
  { name: 'home-proj', path: `${homedir().replace(/\\/g, '/')}/work/my-company` },
  { name: 'encoded', path: '' },
  { name: '-Users-me-Web-thing', path: '' },
]

const PATTERNS = [
  '/Users/me/work/my-company', '/Users/me/work/my-company/', 'my-company', 'MY-COMPANY',
  '/a/Vault', '/a/vault', 'c:/work/vault', 'C:\\Work\\Vault', '//server/share', '/root/vault',
  'root/vault', 'me/work', '/', '//', '', '-Users-me-Web', 'thing', '/nope',
]

// This parity test lives in the CLI suite, not beside the module it covers:
// it needs both halves, and the desktop CI job installs only app/ dependencies,
// so an app-side test importing src/parser.ts fails to resolve chalk there.
// A tilde is absent on purpose: the main process expands it on the way in and
// out of the filter file (see normalizePatterns), so a pattern reaching the
// renderer is already a path it can resolve.
describe('projectMatch parity with the CLI', () => {
  it('agrees with matchesProjectPattern on every pattern and project', () => {
    for (const project of PROJECTS) {
      for (const pattern of PATTERNS) {
        const cli = matchesProjectPattern({ project: project.name, projectPath: project.path }, pattern)
        expect(projectMatches(project, pattern), `${pattern} vs ${project.path || project.name}`).toBe(cli)
      }
    }
  })

  it('anchors the pattern a switch writes, stripped absolute paths included', () => {
    const stripped = PROJECTS.find(p => p.name === 'stripped')!
    const pattern = projectPattern(stripped)
    expect(pattern).toBe('/root/vault')
    expect(matchesProjectPattern({ project: 'stripped', projectPath: 'root/vault' }, pattern)).toBe(true)
    expect(matchesProjectPattern({ project: 'stripped-ui', projectPath: 'root/vault-ui' }, pattern)).toBe(false)
  })

  it('falls back to the name when no path was recorded', () => {
    expect(projectPattern({ name: '-Users-me-Web-thing', path: '' })).toBe('-Users-me-Web-thing')
  })
})
