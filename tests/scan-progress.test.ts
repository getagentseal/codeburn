import { describe, it, expect, vi, afterEach } from 'vitest'
import { createScanProgress, setInteractiveScanUI } from '../src/parser.js'

// The scan-progress line must be silent while an interactive Ink UI (dashboard,
// compare) is live, because it renders to the same terminal. The end-to-end
// proof (cold dashboard WITH a plan stays silent; cold overview shows progress)
// is documented in the PR and was run under a PTY.
describe('createScanProgress gate', () => {
  const origTTY = process.stderr.isTTY

  afterEach(() => {
    setInteractiveScanUI(false)
    Object.defineProperty(process.stderr, 'isTTY', { value: origTTY, configurable: true })
    vi.restoreAllMocks()
  })

  function forceTTY(v: boolean) {
    Object.defineProperty(process.stderr, 'isTTY', { value: v, configurable: true })
  }

  it('writes progress for a plain CLI command in a TTY over the threshold', async () => {
    forceTTY(true)
    const w = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const p = createScanProgress('scanning', 100)
    await p.tick(100) // final tick bypasses the 100ms throttle
    expect(w).toHaveBeenCalled()
    expect(String(w.mock.calls[0]![0])).toContain('scanning 100/100')
  })

  it('goes silent once an interactive Ink UI is active, even in a TTY', async () => {
    forceTTY(true)
    setInteractiveScanUI() // dashboard/compare call this right before render()
    const w = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const p = createScanProgress('scanning', 100)
    for (let i = 1; i <= 100; i++) await p.tick(i)
    p.finish()
    expect(w).not.toHaveBeenCalled()
  })

  it('finish() clears the line when progress was shown', async () => {
    forceTTY(true)
    const w = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const p = createScanProgress('scanning', 100)
    await p.tick(100)
    w.mockClear()
    p.finish()
    expect(String(w.mock.calls[0]![0])).toBe('\r\x1b[K')
  })

  it('writes nothing when stderr is not a TTY (piped/captured output)', async () => {
    forceTTY(false)
    const w = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const p = createScanProgress('scanning', 100)
    await p.tick(100)
    p.finish()
    expect(w).not.toHaveBeenCalled()
  })

  it('stays silent below the small-tree threshold', async () => {
    forceTTY(true)
    const w = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const p = createScanProgress('scanning', 5)
    await p.tick(5)
    expect(w).not.toHaveBeenCalled()
  })
})
