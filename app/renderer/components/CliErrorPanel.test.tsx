// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CliErrorPanel } from './CliErrorPanel'

describe('CliErrorPanel not-found', () => {
  it('gives app advice, not npm, when the bundled engine is unreachable', () => {
    const { container } = render(<CliErrorPanel error={{ kind: 'not-found', message: 'x', stage: 'bundled-missing' }} />)
    expect(container.textContent).toContain('reinstall the app from codeburn.app')
    expect(container.textContent).not.toContain('npm')
  })

  it('tells the user to allow CodeBurn when access was denied', () => {
    const { container } = render(<CliErrorPanel error={{ kind: 'not-found', message: 'x', stage: 'bundled-denied' }} />)
    expect(container.textContent).toContain('Security software')
    expect(container.textContent).not.toContain('npm')
  })

  it('keeps the npm advice when no bundled CLI is configured', () => {
    const { container } = render(<CliErrorPanel error={{ kind: 'not-found', message: 'x', stage: 'no-path-match' }} />)
    expect(container.textContent).toContain('npm i -g codeburn')
  })
})
