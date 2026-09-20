import { describe, expect, it } from 'vitest'

import { emptyCache, hasDirtyDurableProvider, markCacheDirty } from '../src/session-cache.js'

describe('hasDirtyDurableProvider', () => {
  it('covers a provider marked durable on its section, not only the named ones', () => {
    const cache = emptyCache()
    cache.providers['quickdesk'] = { envFingerprint: '', files: {}, durable: true }
    cache.providers['claude'] = { envFingerprint: '', files: {} }

    markCacheDirty(cache, 'claude')
    expect(hasDirtyDurableProvider(cache)).toBe(false)

    markCacheDirty(cache, 'quickdesk')
    expect(hasDirtyDurableProvider(cache)).toBe(true)
  })

  it('still covers copilot before its section carries the flag', () => {
    const cache = emptyCache()
    markCacheDirty(cache, 'copilot')
    expect(hasDirtyDurableProvider(cache)).toBe(true)
  })
})
