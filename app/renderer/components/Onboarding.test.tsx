// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  codeburn: { openExternal: mocks.openExternal },
  normalizeCliError: (err: unknown) => err,
}))

import { Onboarding } from './Onboarding'

function next(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

describe('Onboarding', () => {
  it('walks three feature screens into the consent screen', () => {
    render(<Onboarding defaultEnabled onDone={() => {}} />)

    expect(screen.getByText('Every agent. One dashboard.')).toBeInTheDocument()
    next()
    expect(screen.getByText('Local-first by design.')).toBeInTheDocument()
    next()
    expect(screen.getByText('Find the waste.')).toBeInTheDocument()
    next()
    expect(screen.getByText('Help improve CodeBurn')).toBeInTheDocument()
    // Only the reached segments of the progress line are lit.
    expect(document.querySelectorAll('.onboard-seg.on')).toHaveLength(4)
    // Back returns to the previous screen.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Find the waste.')).toBeInTheDocument()
  })

  it('skips straight to the consent screen, which is never skippable', () => {
    render(<Onboarding defaultEnabled onDone={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.getByText('Help improve CodeBurn')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
  })

  it('advances on ArrowRight and skips on Escape', () => {
    const onDone = vi.fn()
    render(<Onboarding defaultEnabled onDone={onDone} />)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('Local-first by design.')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Help improve CodeBurn')).toBeInTheDocument()

    // Enter on the consent screen finishes rather than advancing past it.
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onDone).toHaveBeenCalledWith(true)
  })

  it('seeds the toggle from the regional default and reports the final choice', () => {
    const onDone = vi.fn()
    render(<Onboarding defaultEnabled={false} onDone={onDone} />)
    next(); next(); next()

    // EU-style default: switch starts off.
    const toggle = screen.getByRole('switch', { name: 'Anonymous telemetry' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    // The user opts in, then finishes.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(onDone).toHaveBeenCalledWith(true)
  })

  it('keeps the regional default when untouched and links the data policy', () => {
    const onDone = vi.fn()
    render(<Onboarding defaultEnabled onDone={onDone} />)
    next(); next(); next()

    fireEvent.click(screen.getByRole('button', { name: 'What data we collect' }))
    expect(mocks.openExternal).toHaveBeenCalledWith('https://www.codeburn.app/telemetry')

    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(onDone).toHaveBeenCalledWith(true)
  })
})
