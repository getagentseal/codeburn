import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { canonicalProjectPath, scopeFilter, workspaceScope } from '../src/workspace'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'codeburn-ws-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('canonicalProjectPath', () => {
  it('keeps a plain folder and a repo subfolder as they are, like the CLI keys a cwd', () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
    mkdirSync(join(root, 'plain'))
    expect(canonicalProjectPath(repo)).toBe(repo)
    expect(canonicalProjectPath(join(repo, 'packages', 'web'))).toBe(join(repo, 'packages', 'web'))
    expect(canonicalProjectPath(join(root, 'plain'))).toBe(join(root, 'plain'))
  })

  it('folds a linked worktree into its main repository', () => {
    const main = join(root, 'main')
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
    const worktree = join(root, 'feature-wt')
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`)
    expect(canonicalProjectPath(worktree)).toBe(main)
    expect(canonicalProjectPath(join(worktree, 'src'))).toBe(main)
  })

  it('leaves a submodule (a .git file that is not a worktree) alone', () => {
    const sub = join(root, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, '.git'), 'gitdir: ../main/.git/modules/sub\n')
    expect(canonicalProjectPath(sub)).toBe(sub)
  })
})

describe('workspaceScope', () => {
  it('names a single folder by its name and a multi-root workspace by the workspace', () => {
    const one = workspaceScope([{ fsPath: join(root, 'plain'), name: 'plain' }])
    expect(one.label).toBe('plain')
    expect(one.paths).toEqual([join(root, 'plain')])
    const two = workspaceScope([{ fsPath: join(root, 'plain'), name: 'plain' }, { fsPath: join(root, 'repo'), name: 'repo' }], 'Both')
    expect(two.label).toBe('Both')
    expect(two.paths).toHaveLength(2)
    expect(two.id).not.toBe(one.id)
  })

  it('has no scope without a folder', () => {
    expect(workspaceScope([])).toEqual({ paths: [], label: null, id: 'none' })
  })

  it('keeps the same id for the same folders', () => {
    const folders = [{ fsPath: join(root, 'plain'), name: 'plain' }]
    expect(workspaceScope(folders).id).toBe(workspaceScope(folders).id)
  })
})

describe('scopeFilter', () => {
  it('replaces the saved includes with the workspace and keeps the excludes', () => {
    const narrow = scopeFilter(['/w/app'])
    expect(narrow({ project: ['other'], exclude: ['-tmp'] })).toEqual({ project: ['/w/app'], exclude: ['-tmp'] })
  })

  it('passes the saved filter through with no workspace', () => {
    const filter = { project: ['a'], exclude: [] }
    expect(scopeFilter([])(filter)).toBe(filter)
  })
})
