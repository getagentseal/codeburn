import { describe, expect, it } from 'vitest'

import { PROVIDER_PARSE_VERSIONS } from '../src/session-cache.js'

describe('provider parse versions', () => {
  it('carry the bumps that re-parse cached sessions after pricing-rule fixes', () => {
    expect(PROVIDER_PARSE_VERSIONS['droid']).toContain('model-minor-version-v1')
    expect(PROVIDER_PARSE_VERSIONS['qwen']).toContain('cached-prompt-v1')
    expect(PROVIDER_PARSE_VERSIONS['qwen']).toContain('output-thoughts-v1')
    expect(PROVIDER_PARSE_VERSIONS['hermes']).toContain('ledger-v4')
  })
})
