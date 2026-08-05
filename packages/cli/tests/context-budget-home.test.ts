import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'

// Mock homedir to a temp dir so "project == home" is reproducible.
import { vi } from 'vitest'
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const fakeHome = fs.mkdtempSync(actual.tmpdir() + '/cb-ctxbudget-home-')
  process.env['CB_CTXBUDGET_FAKE_HOME'] = fakeHome
  return { ...actual, homedir: () => fakeHome }
})

const HOME = process.env['CB_CTXBUDGET_FAKE_HOME']!

import { estimateContextBudget } from '../src/context-budget.js'

describe('context budget: no double-count when the project IS the home dir', () => {
  beforeEach(() => {
    rmSync(join(HOME, '.claude'), { recursive: true, force: true })
    mkdirSync(join(HOME, '.claude', 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(HOME, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# Skill')
    writeFileSync(join(HOME, '.claude', 'CLAUDE.md'), 'home memory')
  })

  it('counts the one home skill once, not twice, when projectPath is home', async () => {
    // With projectPath === home, the home and project skills dirs resolve to
    // the same directory; the unfixed code pushed both and counted every skill
    // twice (and read ~/.claude/CLAUDE.md twice).
    const budget = await estimateContextBudget(HOME)
    expect(budget.skills.count).toBe(1)
    // ~/.claude/CLAUDE.md must appear once in the memory file list.
    const homeMemory = budget.memory.files.filter(f => f.name.includes('.claude/CLAUDE.md'))
    expect(homeMemory).toHaveLength(1)
  })

  it('still counts a distinct project skill separately from a home skill', async () => {
    const proj = mkdtempSync(join(HOME, '..', 'cb-ctxbudget-proj-'))
    mkdirSync(join(proj, '.claude', 'skills', 'proj-skill'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'skills', 'proj-skill', 'SKILL.md'), '# Proj')
    const budget = await estimateContextBudget(proj)
    expect(budget.skills.count).toBe(2) // home skill + project skill
    rmSync(proj, { recursive: true, force: true })
  })

  it('counts the home skill once when projectPath is a symlink into home', async () => {
    // Raw string equality misses this: a session cwd spelled through a link
    // (e.g. /tmp -> /private/tmp, or ~/code -> /Volumes/.../code) points at the
    // same physical skills dir as the home one. Resolving must collapse it or
    // every skill is counted twice.
    const alias = join(HOME, '..', 'cb-ctxbudget-home-alias')
    rmSync(alias, { recursive: true, force: true })
    symlinkSync(HOME, alias, 'dir')
    try {
      const budget = await estimateContextBudget(alias)
      expect(budget.skills.count).toBe(1)
      // Same dedup must hold for memory: the alias spelling of the home
      // .claude/CLAUDE.md resolves to the same file and must be read once.
      const homeMemory = budget.memory.files.filter(f => f.name.includes('.claude/CLAUDE.md'))
      expect(homeMemory).toHaveLength(1)
      expect(budget.memory.count).toBe(1)
    } finally {
      rmSync(alias, { recursive: true, force: true })
    }
  })
})
