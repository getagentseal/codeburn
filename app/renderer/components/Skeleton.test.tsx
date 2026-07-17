// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SectionSkeleton } from './Skeleton'

describe('SectionSkeleton', () => {
  it('renders shimmer blocks and keeps the loading label for screen readers', () => {
    const { container } = render(<SectionSkeleton label="Scanning spend…" rows={4} chart />)

    expect(container.querySelectorAll('.skel').length).toBeGreaterThan(0)
    expect(container.querySelector('.skel-chart')).toBeInTheDocument()

    const label = screen.getByText('Scanning spend…')
    expect(label).toHaveClass('sr-only')
    expect(label).toHaveAttribute('role', 'status')
  })
})
