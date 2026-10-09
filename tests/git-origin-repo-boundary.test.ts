import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => fake.home }
})

import { __resetGitOriginCache, gitOriginKey, saveGitOrigins } from '../src/git-origin.js'

let root: string
const savedCacheDir = process.env['CODEBURN_CACHE_DIR']

function repo(dir: string, origin?: string): string {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\tbare = false\n${origin ? `[remote "origin"]\n\turl = ${origin}\n` : ''}`)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-origin-boundary-'))
  fake.home = join(root, 'home')
  mkdirSync(fake.home)
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  mkdirSync(join(root, 'cache'))
  __resetGitOriginCache()
})

afterEach(() => {
  __resetGitOriginCache()
  if (savedCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = savedCacheDir
  rmSync(root, { recursive: true, force: true })
})

describe('git origin stops at the repository that owns a folder', () => {
  it('gives a local-only repo nested in another repo no origin, and never records the outer one', () => {
    const outer = repo(join(root, 'work', 'monorepo'), 'git@github.com:me/monorepo.git')
    const inner = repo(join(outer, 'experiments', 'foo'))
    mkdirSync(join(inner, 'src'))
    expect(gitOriginKey(inner)).toBeNull()
    expect(gitOriginKey(join(inner, 'src'))).toBeNull()
    expect(gitOriginKey(join(outer, 'experiments'))).toBe('github.com/me/monorepo')
    saveGitOrigins()
    const paths = JSON.parse(readFileSync(join(root, 'cache', 'git-origins.json'), 'utf8')).paths
    expect(paths[inner]).toBeUndefined()
    expect(paths[join(inner, 'src')]).toBeUndefined()
  })

  it('does not hand a dotfiles repo at home to folders below it', () => {
    repo(fake.home, 'https://github.com/me/dotfiles')
    const scratch = join(fake.home, 'Desktop', 'scratch')
    mkdirSync(scratch, { recursive: true })
    const prototype = repo(join(fake.home, 'Projects', 'prototype'))
    expect(gitOriginKey(scratch)).toBeNull()
    expect(gitOriginKey(prototype)).toBeNull()
    expect(gitOriginKey(fake.home)).toBe('github.com/me/dotfiles')
  })

  it('still finds the checkout origin from a subfolder and from a worktree', () => {
    const main = repo(join(fake.home, 'src', 'app'), 'git@github.com:me/app.git')
    mkdirSync(join(main, 'packages', 'web'), { recursive: true })
    expect(gitOriginKey(join(main, 'packages', 'web'))).toBe('github.com/me/app')

    const admin = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(admin, { recursive: true })
    writeFileSync(join(admin, 'commondir'), '../..\n')
    const wt = join(fake.home, 'src', 'app-wt')
    mkdirSync(join(wt, 'lib'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${admin}\n`)
    expect(gitOriginKey(wt)).toBe('github.com/me/app')
    expect(gitOriginKey(join(wt, 'lib'))).toBe('github.com/me/app')
  })
})
