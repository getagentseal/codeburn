// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useEscape } from './useEscape'

function Overlay({ onEscape, active = true }: { onEscape: () => void; active?: boolean }) {
  useEscape(active, onEscape)
  return <div>overlay</div>
}

function Host() {
  const [open, setOpen] = useState(true)
  return open ? <Overlay onEscape={() => setOpen(false)} /> : <div>closed</div>
}

describe('useEscape', () => {
  it('closes the overlay on Escape from anywhere in the document', () => {
    const { getByText } = render(<Host />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(getByText('closed')).toBeInTheDocument()
  })

  it('ignores other keys', () => {
    const onEscape = vi.fn()
    render(<Overlay onEscape={onEscape} />)
    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('does nothing while inactive, and stops listening once unmounted', () => {
    const onEscape = vi.fn()
    render(<Overlay onEscape={onEscape} active={false} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()

    const closable = vi.fn()
    const { unmount } = render(<Overlay onEscape={closable} />)
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closable).not.toHaveBeenCalled()
  })
})
