// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { QuickProjectScopeProvider, useQuickProjectScope } from '../lib/projectScope'
import type { ProjectScopeCatalog, ProjectScopeOption } from '../lib/types'
import { PROJECT_ALPHA, PROJECT_ALPHA_SAME_NAME, PROJECT_PATHLESS } from '../test/projectScopeFixtures'
import { ProjectScopePicker } from './ProjectScopePicker'

const bridge = vi.hoisted(() => ({
  getProjectScopeCatalog: vi.fn<() => Promise<ProjectScopeCatalog>>(),
  validateProjectScope: vi.fn<(id: string, revision: string) => Promise<ProjectScopeOption>>(),
}))

vi.mock('../lib/ipc', () => ({ codeburn: bridge }))

function ScopeProbe() {
  const { quickScope } = useQuickProjectScope()
  return <output data-testid="quick-scope">{JSON.stringify(quickScope)}</output>
}

function renderPicker() {
  return render(
    <QuickProjectScopeProvider>
      <ProjectScopePicker />
      <ScopeProbe />
    </QuickProjectScopeProvider>,
  )
}

async function openPickerAndWaitForCatalog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /project/i }))
  await screen.findByRole('option', { name: 'All projects' })
}

const baseCatalog: ProjectScopeCatalog = {
  revision: 'settings-revision-2026-10-02',
  options: [PROJECT_ALPHA, PROJECT_ALPHA_SAME_NAME, PROJECT_PATHLESS],
}

describe('ProjectScopePicker', () => {
  beforeEach(() => {
    bridge.getProjectScopeCatalog.mockReset().mockResolvedValue({ ...baseCatalog, options: [...baseCatalog.options] })
    bridge.validateProjectScope.mockReset().mockImplementation(async (id, revision) => {
      if (revision !== baseCatalog.revision) throw { kind: 'bad-args', message: 'catalog revision changed' }
      const option = baseCatalog.options.find(candidate => candidate.id === id)
      if (!option) throw { kind: 'bad-args', message: 'project is not permitted' }
      return option
    })
  })

  it('Scenario: the first option is always All projects', async () => {
    const user = userEvent.setup()
    renderPicker()

    await openPickerAndWaitForCatalog(user)

    expect(screen.getAllByRole('option')[0]).toHaveTextContent('All projects')
  })

  it('Scenario: opening lazily loads the lifetime catalog and leaves report scope unchanged while loading', async () => {
    const user = userEvent.setup()
    let resolveCatalog!: (catalog: ProjectScopeCatalog) => void
    bridge.getProjectScopeCatalog.mockReturnValueOnce(new Promise(resolve => { resolveCatalog = resolve }))
    renderPicker()

    await user.click(screen.getByRole('button', { name: /project/i }))

    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    expect(screen.getByTestId('quick-scope')).toHaveTextContent(JSON.stringify({ kind: 'all' }))

    resolveCatalog(baseCatalog)
    await screen.findByRole('option', { name: 'All projects' })
  })

  it('Scenario: a catalog load error disables options and retry reloads the catalog', async () => {
    const user = userEvent.setup()
    bridge.getProjectScopeCatalog
      .mockRejectedValueOnce({ kind: 'timeout', message: 'catalog unavailable' })
      .mockResolvedValueOnce({ ...baseCatalog, options: [...baseCatalog.options] })
    renderPicker()

    await user.click(screen.getByRole('button', { name: /project/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't load permitted projects/i)
    expect(screen.getByRole('option', { name: 'All projects' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(bridge.getProjectScopeCatalog).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('Scenario: search filters labels and paths but selection sends the exact id', async () => {
    const user = userEvent.setup()
    renderPicker()
    await openPickerAndWaitForCatalog(user)

    await user.type(screen.getByRole('searchbox'), '/work/alpha')
    await user.click(screen.getByRole('option', { name: /Alpha.*work\/alpha$/i }))

    expect(bridge.validateProjectScope).toHaveBeenCalledWith(PROJECT_ALPHA.id, baseCatalog.revision)
    await waitFor(() => expect(screen.getByTestId('quick-scope')).toHaveTextContent(PROJECT_ALPHA.id))
  })

  it('Scenario: duplicate names show enough path and expose the full path to assistive technology', async () => {
    const user = userEvent.setup()
    renderPicker()
    await openPickerAndWaitForCatalog(user)

    const duplicate = screen.getByRole('option', { name: /Alpha.*work\/alpha$/i })
    expect(duplicate).toHaveAttribute('title', '/work/alpha')
    expect(duplicate).toHaveAccessibleName(/\/work\/alpha/)
  })

  it('renders the same two project lines as Settings', async () => {
    const user = userEvent.setup()
    renderPicker()
    await openPickerAndWaitForCatalog(user)

    const option = screen.getByRole('option', { name: /work\/alpha.*\/work\/alpha$/i })
    expect(option.querySelector('.project-scope-option-name')).toHaveTextContent('work/alpha')
    expect(option.querySelector('.project-scope-option-path')).toHaveTextContent('/work/alpha')
  })

  it('uses the normalized Settings pattern in the accessible name', async () => {
    const user = userEvent.setup()
    bridge.getProjectScopeCatalog.mockResolvedValueOnce({
      revision: baseCatalog.revision,
      options: [{ id: 'label:Users/x/project', name: 'project', path: 'Users/x/project' }],
    })
    renderPicker()
    await openPickerAndWaitForCatalog(user)

    expect(screen.getByRole('option', { name: 'project, /Users/x/project' })).toBeInTheDocument()
  })

  it('Scenario: pathless projects expose the localized unavailable-path text', async () => {
    const user = userEvent.setup()
    renderPicker()
    await openPickerAndWaitForCatalog(user)

    const pathless = screen.getByRole('option', { name: /Alpha.*Path unavailable/i })
    expect(pathless).toHaveAccessibleName(/Path unavailable/)
  })

  it('Scenario: Escape closes and restores focus to the trigger', async () => {
    const user = userEvent.setup()
    renderPicker()
    const trigger = screen.getByRole('button', { name: /project/i })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(trigger).toHaveFocus()
  })

  it('Scenario: a revision mismatch keeps the prior scope and offers retry', async () => {
    const user = userEvent.setup()
    renderPicker()
    await openPickerAndWaitForCatalog(user)
    bridge.validateProjectScope.mockRejectedValueOnce({ kind: 'bad-args', message: 'catalog revision changed' })

    await user.click(screen.getByRole('option', { name: /Alpha.*work\/alpha$/i }))

    expect(screen.getByTestId('quick-scope')).toHaveTextContent(JSON.stringify({ kind: 'all' }))
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('closes the picker while a catalog revision reloads', async () => {
    const user = userEvent.setup()
    let resolveReload!: (catalog: ProjectScopeCatalog) => void
    bridge.getProjectScopeCatalog
      .mockReset()
      .mockResolvedValueOnce({ ...baseCatalog, options: [...baseCatalog.options] })
      .mockReturnValueOnce(new Promise(resolve => { resolveReload = resolve }))
    bridge.validateProjectScope.mockRejectedValueOnce({ kind: 'bad-args', message: 'catalog revision changed' })
    renderPicker()
    await openPickerAndWaitForCatalog(user)

    await user.click(screen.getByRole('option', { name: /Alpha.*work\/alpha$/i }))
    await waitFor(() => expect(bridge.getProjectScopeCatalog).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    resolveReload({ ...baseCatalog, revision: 'revision-2', options: [...baseCatalog.options] })
  })

  it('Scenario: an empty filtered catalog explains why no project is available', async () => {
    const user = userEvent.setup()
    bridge.getProjectScopeCatalog.mockResolvedValueOnce({ ...baseCatalog, options: [] })
    renderPicker()

    await user.click(screen.getByRole('button', { name: /project/i }))

    expect(await screen.findByText(/settings permits no project/i)).toBeInTheDocument()
  })

  it('supports keyboard navigation and selection without adding another tab stop', async () => {
    const user = userEvent.setup()
    renderPicker()
    await openPickerAndWaitForCatalog(user)

    const search = screen.getByRole('searchbox')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(bridge.validateProjectScope).toHaveBeenCalledWith(PROJECT_ALPHA.id, baseCatalog.revision)
    expect(search).not.toBeInTheDocument()
  })
})
