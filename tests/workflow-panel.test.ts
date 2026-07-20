import { describe, it, expect } from 'vitest'

import { buildWorkflowRows, hasWorkflowData, selectRotatingNote, type WorkflowPanelData } from '../src/dashboard.js'

function data(overrides: Partial<WorkflowPanelData> = {}): WorkflowPanelData {
  return {
    correctionRate: 0.12,
    corrections: 5,
    userTurns: 40,
    medianTimeToFirstEditMs: 8000,
    topReworkedFile: { path: 'src/dashboard.tsx', sessions: 4, edits: 12 },
    coverage: 0.98,
    ...overrides,
  }
}

describe('buildWorkflowRows', () => {
  it('formats the four rows with aligned labels', () => {
    expect(buildWorkflowRows(data())).toEqual([
      { label: 'Corrections', value: '12% (5)' },
      { label: 'First edit', value: '8s' },
      { label: 'Rework', value: 'dashboard.tsx ×4' },
      { label: 'Coverage', value: '98%' },
    ])
  })

  it('omits the Coverage row when coverage is null (never renders a placeholder 100%)', () => {
    const rows = buildWorkflowRows(data({ coverage: null }))
    expect(rows.map(r => r.label)).toEqual(['Corrections', 'First edit', 'Rework'])
    expect(rows.some(r => r.value === '100%')).toBe(false)
  })

  it('keeps a genuine full-coverage row (100% is a real value, not the null placeholder)', () => {
    expect(buildWorkflowRows(data({ coverage: 1 }))[3]).toEqual({ label: 'Coverage', value: '100%' })
  })

  it('formats the first-edit median as seconds under a minute and whole minutes above', () => {
    expect(buildWorkflowRows(data({ medianTimeToFirstEditMs: 45_000 }))[1]!.value).toBe('45s')
    expect(buildWorkflowRows(data({ medianTimeToFirstEditMs: 60_000 }))[1]!.value).toBe('1m')
    expect(buildWorkflowRows(data({ medianTimeToFirstEditMs: 90_000 }))[1]!.value).toBe('2m')
  })

  it('takes the basename of the rework path and pluralizes with ×sessions', () => {
    expect(buildWorkflowRows(data({ topReworkedFile: { path: 'a/b/c/parser.ts', sessions: 3, edits: 9 } }))[2]!.value).toBe('parser.ts ×3')
    expect(buildWorkflowRows(data({ topReworkedFile: { path: 'C:\\win\\path\\file.ts', sessions: 2, edits: 5 } }))[2]!.value).toBe('file.ts ×2')
  })

  it('rounds the correction percentage and shows the count', () => {
    expect(buildWorkflowRows(data({ correctionRate: 0.153, corrections: 7 }))[0]!.value).toBe('15% (7)')
  })

  it('shows a dash for each missing value and still omits coverage', () => {
    const rows = buildWorkflowRows(data({ correctionRate: null, medianTimeToFirstEditMs: null, topReworkedFile: null, coverage: null }))
    expect(rows).toEqual([
      { label: 'Corrections', value: '-' },
      { label: 'First edit', value: '-' },
      { label: 'Rework', value: '-' },
    ])
  })
})

describe('hasWorkflowData', () => {
  it('shows the panel when there are user turns', () => {
    expect(hasWorkflowData(data({ userTurns: 3, topReworkedFile: null }))).toBe(true)
  })

  it('shows the panel when there is file churn even without user turns', () => {
    expect(hasWorkflowData(data({ userTurns: 0, topReworkedFile: { path: 'x.ts', sessions: 1, edits: 1 } }))).toBe(true)
  })

  it('hides the panel when there are no user turns and no churn', () => {
    expect(hasWorkflowData(data({ userTurns: 0, topReworkedFile: null }))).toBe(false)
  })
})

describe('selectRotatingNote', () => {
  it('returns null when there are no notes', () => {
    expect(selectRotatingNote([], 0)).toBeNull()
    expect(selectRotatingNote([], 5)).toBeNull()
  })

  it('returns the only note for any tick', () => {
    expect(selectRotatingNote(['a'], 0)).toBe('a')
    expect(selectRotatingNote(['a'], 7)).toBe('a')
  })

  it('cycles through the notes by tick', () => {
    const notes = ['a', 'b', 'c']
    expect([0, 1, 2, 3, 4].map(t => selectRotatingNote(notes, t))).toEqual(['a', 'b', 'c', 'a', 'b'])
  })

  it('handles negative ticks without crashing', () => {
    expect(selectRotatingNote(['a', 'b'], -1)).toBe('b')
  })
})
