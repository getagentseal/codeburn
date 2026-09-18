import { describe, expect, it } from 'vitest'

import { topLevelPackagesFromNpmLs } from './stage-cli-packages.mjs'

// `npm ls --parseable` parsed without anchoring on the absolute checkout path.
// npm 11 and later redact UUID-shaped path segments to `***` (observed with
// npm 11.19.0: a checkout at /tmp/1a2b3c4d-1111-2222-3333-444455556666/probe
// prints /private/tmp/***/probe as its root line), which is why #1466's
// absolute-prefix match aborted packaging on any UUID-containing path. These
// fixtures pin the real output shapes, redacted and not. The root's
// node_modules is located by segment position — however many `/node_modules/`
// segments the root path itself contains, the top-level name sits one past
// that count.

const ROOT_MODULES = '/repo/codeburn/node_modules'

describe('topLevelPackagesFromNpmLs', () => {
  it('reads top-level names from paths whose UUID segments npm redacted', () => {
    const listed = [
      '/private/tmp/1a2b3c4d-1111-2222-3333-444455556666/codeburn',
      '/private/tmp/1a2b3c4d-1111-2222-3333-444455556666/codeburn/node_modules/@modelcontextprotocol/sdk',
      '/private/tmp/1a2b3c4d-1111-2222-3333-444455556666/codeburn/node_modules/chalk',
      '/private/tmp/1a2b3c4d-1111-2222-3333-444455556666/codeburn/node_modules/react/node_modules/loose-envify',
    ].join('\n')
    expect(topLevelPackagesFromNpmLs(listed, ROOT_MODULES)).toEqual(new Set(['@modelcontextprotocol/sdk', 'chalk', 'react']))
  })

  it('keeps the redacted shape working, which the old prefix match could not', () => {
    // This is the literal output npm 11.19.0 prints for the checkout above: the
    // UUID segment is `***` on every line. The old absolute-prefix match found
    // zero packages here and aborted the build.
    const listed = [
      '/private/tmp/***/probe-29473',
      '/private/tmp/***/probe-29473/node_modules/lodash',
    ].join('\n')
    expect(topLevelPackagesFromNpmLs(listed, '/tmp/1a2b3c4d-1111-2222-3333-444455556666/probe-29473/node_modules')).toEqual(new Set(['lodash']))
  })

  it('stays correct when the checkout itself lives inside a node_modules directory', () => {
    // The root path contains one node_modules segment of its own, so the
    // project's packages sit one segment deeper. A first-occurrence parser
    // would read the checkout's directory name (`codeburn`) off every line.
    const nestedRoot = '/other/repo/node_modules/codeburn/node_modules'
    const listed = [
      '/other/repo/node_modules/codeburn',
      '/other/repo/node_modules/codeburn/node_modules/chalk',
      '/other/repo/node_modules/codeburn/node_modules/react-dom/node_modules/scheduler',
    ].join('\n')
    expect(topLevelPackagesFromNpmLs(listed, nestedRoot)).toEqual(new Set(['chalk', 'react-dom']))
  })

  it('maps a nested transitive path to its top-level ancestor, not the leaf', () => {
    const listed = '/repo/codeburn/node_modules/react-dom/node_modules/scheduler\n/repo/codeburn/node_modules/react-dom'
    expect(topLevelPackagesFromNpmLs(listed, ROOT_MODULES)).toEqual(new Set(['react-dom']))
  })

  it('normalizes Windows separators on both the lines and the root path', () => {
    const listed = [
      'C:\\repo\\codeburn',
      'C:\\repo\\codeburn\\node_modules\\undici',
      'C:\\repo\\codeburn\\node_modules\\@scope\\pkg\\node_modules\\dep',
    ].join('\n')
    expect(topLevelPackagesFromNpmLs(listed, 'C:\\repo\\codeburn\\node_modules')).toEqual(new Set(['undici', '@scope/pkg']))
  })

  it('skips the project-root line, truncated bare scopes, and empty output', () => {
    expect(topLevelPackagesFromNpmLs('/repo/codeburn', ROOT_MODULES)).toEqual(new Set())
    expect(topLevelPackagesFromNpmLs('', ROOT_MODULES)).toEqual(new Set())
    expect(topLevelPackagesFromNpmLs('\n\n', ROOT_MODULES)).toEqual(new Set())
    // A truncated tail that leaves a bare scope is not a package name: without
    // the guard, join(root, '@scope') is a real directory and the whole scope
    // would be copied as one "package".
    expect(topLevelPackagesFromNpmLs('/repo/codeburn/node_modules/@scope', ROOT_MODULES)).toEqual(new Set())
    expect(topLevelPackagesFromNpmLs('/repo/codeburn/node_modules/@scope/', ROOT_MODULES)).toEqual(new Set())
  })
})
