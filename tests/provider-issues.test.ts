import { describe, expect, it } from 'vitest'

import { discoverAllSessionsWithFailures } from '../src/providers/index.js'
import type { Provider } from '../src/providers/types.js'
import { providerIssueKind, providerIssues, recordProviderIssue } from '../src/provider-issues.js'

function provider(name: string, discover: () => Promise<never[]>): Provider {
  return { name, discoverSessions: discover } as unknown as Provider
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: /Users/someone/secret/path`), { code })
}

describe('provider issues', () => {
  it('classifies by code and type, never by message', () => {
    expect(providerIssueKind(errno('EACCES'))).toBe('eacces')
    expect(providerIssueKind(errno('EPERM'))).toBe('eacces')
    expect(providerIssueKind(errno('ENOENT'))).toBe('enoent')
    expect(providerIssueKind(errno('SQLITE_BUSY'))).toBe('busy')
    expect(providerIssueKind(new SyntaxError('Unexpected token'))).toBe('malformed')
    expect(providerIssueKind(new Error('permission denied'))).toBe('error')
  })

  it('records a failed discovery as locate and clears it once discovery works again', async () => {
    let fail = true
    const flaky = provider('flaky-test', async () => {
      if (fail) throw errno('EACCES')
      return []
    })
    await discoverAllSessionsWithFailures(undefined, [flaky])
    expect(providerIssues()).toContainEqual({ provider: 'flaky-test', stage: 'locate', kind: 'eacces' })
    expect(JSON.stringify(providerIssues())).not.toContain('/Users')

    fail = false
    await discoverAllSessionsWithFailures(undefined, [flaky])
    expect(providerIssues().some(issue => issue.provider === 'flaky-test')).toBe(false)
  })

  it('keeps one entry per provider and stage', () => {
    recordProviderIssue('dup-test', 'parse', new SyntaxError('x'))
    recordProviderIssue('dup-test', 'parse', errno('ENOENT'))
    expect(providerIssues().filter(issue => issue.provider === 'dup-test')).toEqual([
      { provider: 'dup-test', stage: 'parse', kind: 'enoent' },
    ])
  })
})
