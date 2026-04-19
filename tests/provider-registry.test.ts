import { describe, it, expect } from 'vitest'
import { providers } from '../src/providers/index.js'

describe('provider registry', () => {
  it('contains only auggie', () => {
    expect(providers.map(p => p.name)).toEqual(['auggie'])
  })
})
