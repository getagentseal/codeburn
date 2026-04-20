import { describe, expect, it, vi } from 'vitest'

import { createTerminalProgressReporter } from '../src/parse-progress.js'

describe('createTerminalProgressReporter', () => {
  it('renders Updating cache progress lines to stderr-compatible streams', () => {
    const writes: string[] = []
    const stream = {
      isTTY: true,
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
    } as unknown as NodeJS.WriteStream

    const reporter = createTerminalProgressReporter(true, stream)
    reporter?.start('Updating cache', 2)
    reporter?.advance('claude/session.jsonl')
    reporter?.advance('codex/rollout.jsonl')
    reporter?.finish()

    expect(writes.join('')).toContain('Updating cache')
    expect(writes.join('')).toContain('2/2')
  })
})
