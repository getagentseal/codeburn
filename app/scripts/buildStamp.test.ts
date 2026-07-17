import { describe, expect, it } from 'vitest'

import { GENERATED_DATA_FILES, isDirtyIgnoringGenerated } from './buildStamp'

describe('isDirtyIgnoringGenerated', () => {
  it('reads clean on an empty status', () => {
    expect(isDirtyIgnoringGenerated('')).toBe(false)
    expect(isDirtyIgnoringGenerated('\n')).toBe(false)
  })

  it('reads clean when only the regenerated pricing snapshots differ', () => {
    const porcelain = GENERATED_DATA_FILES.map(f => ` M ${f}`).join('\n')
    expect(isDirtyIgnoringGenerated(porcelain)).toBe(false)
  })

  it('reads clean for a single regenerated data file', () => {
    expect(isDirtyIgnoringGenerated(' M src/data/litellm-snapshot.json')).toBe(false)
  })

  it('reads dirty when a source file also differs', () => {
    const porcelain = ' M src/data/litellm-snapshot.json\n M app/renderer/components/AboutModal.tsx'
    expect(isDirtyIgnoringGenerated(porcelain)).toBe(true)
  })

  it('reads dirty for a staged source change', () => {
    expect(isDirtyIgnoringGenerated('M  src/cli.ts')).toBe(true)
  })

  it('reads dirty for an untracked file', () => {
    expect(isDirtyIgnoringGenerated('?? some-new-file.ts')).toBe(true)
  })

  it('counts a rename by its destination path', () => {
    expect(isDirtyIgnoringGenerated('R  old/path.ts -> src/data/other.ts')).toBe(true)
  })
})
