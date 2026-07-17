// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StaleBanner } from './StaleBanner'

describe('StaleBanner', () => {
  it('shows the last-good notice with the error summary', () => {
    render(<StaleBanner error={{ kind: 'nonzero', message: 'codeburn exited 1' }} />)

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Refresh failed, showing last good data · codeburn exited 1')
  })
})
