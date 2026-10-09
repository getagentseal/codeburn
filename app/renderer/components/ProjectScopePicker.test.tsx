// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ProjectRow } from '../lib/types'
import { matchProjectOptions, ProjectScopePicker, projectScopeOptions } from './ProjectScopePicker'

const mocks = vi.hoisted(() => ({
  getUnfilteredProjects: vi.fn(),
  getProjectFilter: vi.fn(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const row = (path: string, cost: number, name = path.split('/').pop() ?? path): ProjectRow => ({ name, path, cost, sessions: 1 })
const NO_FILTER = { project: [], exclude: [] }

describe('projectScopeOptions', () => {
  it('lists projects costliest first, keyed by their absolute path', () => {
    const options = projectScopeOptions([row('/w/a', 1), row('/w/b', 5)], NO_FILTER)
    expect(options.map(option => option.value)).toEqual(['/w/b', '/w/a'])
  })

  it('offers only what the saved filter shows', () => {
    const projects = [row('/w/app', 3), row('/w/app-ui', 2), row('/w/scratch', 1)]
    expect(projectScopeOptions(projects, { project: [], exclude: ['scratch'] }).map(option => option.value)).toEqual(['/w/app', '/w/app-ui'])
    // A rooted include anchors on the path boundary: /w/app does not take /w/app-ui.
    expect(projectScopeOptions(projects, { project: ['/w/app'], exclude: [] }).map(option => option.value)).toEqual(['/w/app'])
  })

  it('drops rows without an absolute path: imports and label fallbacks have no cwd', () => {
    const projects = [
      row('', 9, 'my-chat'),
      row('Cursor (imported)', 900, 'Cursor (imported)'),
      row('Grok Bot (imported)', 480, 'Grok Bot (imported)'),
      row('eywa/lab', 100, 'eywa-lab'),
      row('Users/me/api/server', 12, 'Users-me-api-server'),
      row('-Users-me-app', 7, '-Users-me-app'),
      row('/w/a', 1),
      row('C:\\work\\b', 1),
    ]
    expect(projectScopeOptions(projects, NO_FILTER).map(option => option.value)).toEqual(['/w/a', 'C:\\work\\b'])
  })

  it('names a repository row after the repository', () => {
    const repo = { ...row('/w/codeburn', 9, 'codeburn'), checkouts: [{ path: '/w/codeburn', cost: 6 }, { path: '/tmp/clone-3', cost: 3 }] }
    expect(projectScopeOptions([repo, row('/w/site', 1)], NO_FILTER).map(option => option.label)).toEqual(['codeburn', 'w/site'])
  })

  it('offers the temporary-folders row and hides a repository excluded whole by any checkout', () => {
    const repo = { ...row('/w/codeburn', 9, 'codeburn'), checkouts: [{ path: '/w/codeburn', cost: 6 }, { path: '/tmp/clone-3', cost: 3 }] }
    const temp = { ...row('@temp', 4, 'Temporary folders'), temporary: true }
    expect(projectScopeOptions([repo, temp], NO_FILTER).map(option => [option.value, option.label])).toEqual([['/w/codeburn', 'codeburn'], ['@temp', 'Temporary folders']])
    expect(projectScopeOptions([repo, temp], { project: [], exclude: ['=/tmp/clone-3'] }).map(option => option.value)).toEqual(['@temp'])
    expect(projectScopeOptions([repo, temp], { project: [], exclude: ['/tmp/clone-3'] }).map(option => option.value)).toEqual(['/w/codeburn', '@temp'])
  })

  it('notes a repository row that holds a folder matched by name', () => {
    const repo = { ...row('/w/codeburn', 9, 'codeburn'), checkouts: [{ path: '/w/codeburn', cost: 6 }, { path: '/w/codeburn-fix', cost: 3, matchedByFolderName: true }] }
    const plain = { ...row('/w/other', 5, 'other'), checkouts: [{ path: '/w/other', cost: 4 }, { path: '/w/other-wt', cost: 1 }] }
    expect(projectScopeOptions([repo, plain], NO_FILTER).map(option => option.title)).toEqual(['Includes deleted folders matched by folder name only', undefined])
  })

  it('hides projects whose lifetime cost rounds to $0.00', () => {
    const projects = [row('/w/zero', 0), row('/w/tiny', 0.004), row('/w/half', 0.005), row('/w/cent', 0.01)]
    expect(projectScopeOptions(projects, NO_FILTER).map(option => option.value)).toEqual(['/w/cent', '/w/half'])
  })

  it('shows the full path when two projects share a short name', () => {
    const options = projectScopeOptions([row('/a/x/site', 2), row('/b/x/site', 1), row('/c/api', 1)], NO_FILTER)
    expect(options.map(option => option.label)).toEqual(['/a/x/site', '/b/x/site', 'c/api'])
  })
})

describe('matchProjectOptions', () => {
  const options = projectScopeOptions([row('/Users/me/work/site', 2), row('/Users/me/play/api', 1)], NO_FILTER)

  it('matches the label or the full path, ignoring case', () => {
    expect(matchProjectOptions(options, 'SITE').map(option => option.value)).toEqual(['/Users/me/work/site'])
    expect(matchProjectOptions(options, 'me/play').map(option => option.value)).toEqual(['/Users/me/play/api'])
  })

  it('returns everything for a blank query', () => {
    expect(matchProjectOptions(options, '  ')).toBe(options)
  })
})

describe('ProjectScopePicker', () => {
  it('loads on first open, searches by path, and picks with the keyboard', async () => {
    mocks.getUnfilteredProjects.mockResolvedValue({ projects: [row('/w/site', 2, '-w-site'), row('/w/api', 1)] })
    mocks.getProjectFilter.mockResolvedValue(NO_FILTER)
    const onSelect = vi.fn()
    render(<ProjectScopePicker value={null} onSelect={onSelect} />)
    expect(mocks.getUnfilteredProjects).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Project' }))
    expect(await screen.findByRole('option', { name: 'w/site' })).toBeInTheDocument()
    const search = screen.getByRole('searchbox', { name: 'Search projects' })
    expect(search).toHaveFocus()

    await userEvent.type(search, 'api')
    expect(screen.queryByRole('option', { name: 'w/site' })).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith({ name: 'api', path: '/w/api' })
  })

  it('goes back to every project from the pinned first option', async () => {
    mocks.getUnfilteredProjects.mockResolvedValue({ projects: [row('/w/site', 2)] })
    mocks.getProjectFilter.mockResolvedValue(NO_FILTER)
    const onSelect = vi.fn()
    render(<ProjectScopePicker value={{ name: 'site', path: '/w/site' }} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Project' }))
    await userEvent.click(await screen.findByRole('option', { name: 'All projects' }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})
