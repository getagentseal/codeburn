// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopePicker } from './components/ProjectScopePicker'
import { QuickProjectScopeProvider } from './lib/projectScope'
import { PROJECT_ALPHA, PROJECT_ALPHA_SAME_NAME, PROJECT_PATHLESS, payloadForScope } from './test/projectScopeFixtures'

const bridge = vi.hoisted(() => ({
  getProjectScopeCatalog: vi.fn(),
  validateProjectScope: vi.fn(),
}))
vi.mock('./lib/ipc', () => ({ codeburn: bridge }))

function renderPicker() {
  return render(
    <QuickProjectScopeProvider>
      <ProjectScopePicker />
    </QuickProjectScopeProvider>,
  )
}

describe('Feature: exact Desktop project scope', () => {
  beforeEach(() => {
    bridge.getProjectScopeCatalog.mockReset().mockResolvedValue({ revision: 'revision-1', options: [PROJECT_ALPHA, PROJECT_ALPHA_SAME_NAME, PROJECT_PATHLESS] })
    bridge.validateProjectScope.mockReset().mockImplementation(async (id: string, revision: string) => {
      if (revision !== 'revision-1') throw new Error('catalog revision changed')
      const option = [PROJECT_ALPHA, PROJECT_ALPHA_SAME_NAME, PROJECT_PATHLESS].find(candidate => candidate.id === id)
      if (!option) throw new Error('project is not permitted')
      return option
    })
  })

  it('Scenario: duplicate display names remain separately selectable by path', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole('button', { name: /project/i }))
    await screen.findByRole('option', { name: 'All projects' })
    await user.click(screen.getByRole('option', { name: /Alpha.*work\/alpha-ui$/i }))

    await waitFor(() => expect(bridge.validateProjectScope).toHaveBeenCalledWith(PROJECT_ALPHA_SAME_NAME.id, 'revision-1'))
  })

  it('Scenario: persistent Settings visibility remains the outer boundary', async () => {
    const user = userEvent.setup()
    renderPicker()
    bridge.getProjectScopeCatalog.mockResolvedValueOnce({ revision: 'revision-1', options: [PROJECT_ALPHA] })
    await user.click(screen.getByRole('button', { name: /project/i }))

    expect(await screen.findByRole('option', { name: /Alpha.*work\/alpha$/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /alpha-ui/i })).not.toBeInTheDocument()
  })

  it('Scenario: legacy history is available to All projects but not a selected project', () => {
    const all = payloadForScope()
    const selected = payloadForScope(PROJECT_ALPHA.id)

    expect(all.current.cost).toBeGreaterThan(selected.current.cost)
    expect(selected.current.topProjects).toEqual([
      expect.objectContaining({ id: PROJECT_ALPHA.id }),
    ])
  })
})
