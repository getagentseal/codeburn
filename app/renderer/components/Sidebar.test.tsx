// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { Sidebar } from './Sidebar'

describe('Sidebar', () => {
  it('renders all six nav items', () => {
    render(<Sidebar active="overview" onNavigate={() => {}} />)
    expect(screen.getAllByRole('button')).toHaveLength(6)
    for (const label of ['Overview', 'Spend', 'Optimize', 'Models', 'Plans', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
  })

  it('calls onNavigate with the section id when a nav item is clicked', () => {
    const onNavigate = vi.fn()
    render(<Sidebar active="overview" onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: /Spend/ }))
    expect(onNavigate).toHaveBeenCalledWith('spend')
  })

  it('marks the active item with the "on" class', () => {
    render(<Sidebar active="models" onNavigate={() => {}} />)
    expect(screen.getByRole('button', { name: /Models/ })).toHaveClass('on')
    expect(screen.getByRole('button', { name: /Overview/ })).not.toHaveClass('on')
  })
})
