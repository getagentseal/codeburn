// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProviderLogo } from './ProviderLogo'

describe('ProviderLogo', () => {
  it('renders a single image mark for a known provider id', () => {
    const { container } = render(<ProviderLogo provider="hermes" />)
    const img = container.querySelector('img.provider-logo')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src')
    expect(container.querySelector('.provider-mono')).toBeNull()
  })

  it('renders themed light/dark marks for a themed provider id', () => {
    const { container } = render(<ProviderLogo provider="grok" />)
    expect(container.querySelector('img.provider-logo.pl-light')).toBeInTheDocument()
    expect(container.querySelector('img.provider-logo.pl-dark')).toBeInTheDocument()
  })

  it('renders a monogram badge (never null) for an unknown provider id', () => {
    const { container } = render(<ProviderLogo provider="codebuff" />)
    const mono = container.querySelector('span.provider-mono')
    expect(mono).toBeInTheDocument()
    expect(mono).toHaveTextContent('C')
    expect(container.querySelector('img')).toBeNull()
  })

  it('falls back to a monogram for a lowercased display-name key with spaces', () => {
    const { container } = render(<ProviderLogo provider="grok build" />)
    expect(container.querySelector('span.provider-mono')).toHaveTextContent('G')
  })
})
