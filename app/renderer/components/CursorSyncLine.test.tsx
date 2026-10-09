import { describe, expect, it } from 'vitest'

import { cursorSyncLine } from './CursorSyncLine'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

describe('cursorSyncLine', () => {
  it('words each state, hiding the line when sync is off', () => {
    expect(cursorSyncLine({ enabled: true, state: 'ok', lastSuccessAt: ago(0.5) }, NOW)).toEqual({ text: 'Synced from cursor.com just now', warn: false })
    expect(cursorSyncLine({ enabled: true, state: 'ok', lastSuccessAt: ago(12) }, NOW)).toEqual({ text: 'Synced from cursor.com 12 minutes ago', warn: false })
    expect(cursorSyncLine({ enabled: true, state: 'ok', lastSuccessAt: ago(180) }, NOW)?.text).toBe('Synced from cursor.com 3 hours ago')
    expect(cursorSyncLine({ enabled: true, state: 'syncing-never', lastSuccessAt: null }, NOW)).toEqual({ text: 'Not synced from cursor.com yet', warn: false })
    expect(cursorSyncLine({ enabled: false, state: 'off', lastSuccessAt: ago(5) }, NOW)).toBeNull()
  })

  it('maps error codes to fixed copy, never the CLI text', () => {
    const error = 'raw text from somewhere'
    expect(cursorSyncLine({ enabled: true, state: 'no-login', lastSuccessAt: null, errorCode: 'login', error }, NOW)).toEqual({ text: 'Cursor login expired, open Cursor to sign in again', warn: true })
    expect(cursorSyncLine({ enabled: true, state: 'error', lastSuccessAt: ago(90), errorCode: 'network', error }, NOW)).toEqual({ text: "Couldn't reach cursor.com, will retry", warn: true })
    expect(cursorSyncLine({ enabled: true, state: 'error', lastSuccessAt: null, errorCode: 'export', error }, NOW)?.text).toBe("Couldn't read the usage export from cursor.com, will retry")
    expect(cursorSyncLine({ enabled: true, state: 'error', lastSuccessAt: null, errorCode: 'future' as 'export', error }, NOW)?.text).toBe("Couldn't read the usage export from cursor.com, will retry")
  })
})
