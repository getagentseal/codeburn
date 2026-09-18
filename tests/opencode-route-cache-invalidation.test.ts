import { createHash } from 'crypto'

import { describe, expect, it } from 'vitest'

import { computeEnvFingerprint } from '../src/session-cache.js'

function preOpenRouterRouteFingerprint(): string {
  const parts = [
    `XDG_DATA_HOME=${process.env['XDG_DATA_HOME'] ?? ''}`,
    `OPENCODE_DATA_DIR=${process.env['OPENCODE_DATA_DIR'] ?? ''}`,
    `OPENCODE_DB_PREFIX=${process.env['OPENCODE_DB_PREFIX'] ?? ''}`,
    'parser=session-model-v1-archived-subtree-v1',
  ]
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

function preKiloCodeOpenRouterRouteFingerprint(): string {
  const parts = [
    `XDG_DATA_HOME=${process.env['XDG_DATA_HOME'] ?? ''}`,
    'parser=worktree-project-grouping-v1-session-model-v1-archived-subtree-v1',
  ]
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

function openCodeOpenRouterOnlyFingerprint(): string {
  const parts = [
    `XDG_DATA_HOME=${process.env['XDG_DATA_HOME'] ?? ''}`,
    `OPENCODE_DATA_DIR=${process.env['OPENCODE_DATA_DIR'] ?? ''}`,
    `OPENCODE_DB_PREFIX=${process.env['OPENCODE_DB_PREFIX'] ?? ''}`,
    'parser=session-model-v1-archived-subtree-v1-openrouter-route-v1',
  ]
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

function kiloCodeOpenRouterOnlyFingerprint(): string {
  const parts = [
    `XDG_DATA_HOME=${process.env['XDG_DATA_HOME'] ?? ''}`,
    'parser=worktree-project-grouping-v1-session-model-v1-archived-subtree-v1-openrouter-route-v1',
  ]
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

describe('OpenCode-style route cache invalidation', () => {
  it('invalidates OpenCode caches written before providerID became route provenance', () => {
    expect(computeEnvFingerprint('opencode')).not.toBe(preOpenRouterRouteFingerprint())
  })

  it('invalidates OpenCode caches written before Amazon Bedrock providerID support', () => {
    expect(computeEnvFingerprint('opencode')).not.toBe(openCodeOpenRouterOnlyFingerprint())
  })

  it('invalidates KiloCode caches written before the shared parser gained route provenance', () => {
    expect(computeEnvFingerprint('kilo-code')).not.toBe(preKiloCodeOpenRouterRouteFingerprint())
  })

  it('invalidates KiloCode caches written before Amazon Bedrock providerID support', () => {
    expect(computeEnvFingerprint('kilo-code')).not.toBe(kiloCodeOpenRouterOnlyFingerprint())
  })
})
