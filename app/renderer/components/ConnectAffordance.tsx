import { useState } from 'react'

import { t } from '../i18n'
import { PROVIDER_NAMES } from '../lib/providers'
import type { QuotaProvider } from '../lib/types'

// The exact terminal login command per provider. No interactive login is
// attempted from the app — we only show the command to copy and a Refresh.
// Providers without a CLI login (Copilot signs in from an editor plugin;
// Antigravity is local-only; ZCode signs in inside its own app) get a note
// instead of a command.
// hint/note are translation keys (resolved with t() at render time), not text.
const LOGIN: Record<QuotaProvider['provider'], { command?: string; hintKey?: string; noteKey?: string }> = {
  claude: { command: 'claude', hintKey: 'shell.connect.claude.hint' },
  codex: { command: 'codex login' },
  gemini: { command: 'gemini', hintKey: 'shell.connect.signInPrompt' },
  copilot: { noteKey: 'shell.connect.copilot.note' },
  antigravity: { noteKey: 'shell.connect.antigravity.note' },
  kimi: { command: 'kimi', hintKey: 'shell.connect.signInPrompt' },
  zcode: { noteKey: 'shell.connect.zcode.note' },
  grokbot: { noteKey: 'shell.connect.grokbot.note' },
}

/** Inline "Connect" affordance for a disconnected or access-denied provider: a
 * short status line plus a text-button that expands the copy-paste login
 * command, the keychain-Allow note (access-denied), and a forced Refresh. */
export function ConnectAffordance({ provider, connection, onRefresh, message: messageOverride }: {
  provider: QuotaProvider['provider']
  connection: 'disconnected' | 'accessDenied'
  onRefresh: () => void
  /** Replace the default status line, keeping the same Connect/Refresh flow —
   *  used for a login-expiry error or a capped "waiting" state. */
  message?: string
}) {
  const [open, setOpen] = useState(false)
  const name = PROVIDER_NAMES[provider]
  const message = messageOverride ?? (connection === 'accessDenied'
    ? t('shell.connect.accessDenied')
    : t('shell.connect.notConnected', { name }))
  const login = LOGIN[provider]

  return (
    <div className="quota-connect">
      <span className="quota-connection-note">{message}</span>
      <button type="button" className="set-text-button quota-connect-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('shell.action.connect')}</button>
      {open && (
        <div className="quota-connect-guide">
          {login.command ? (
            <>
              <p className="quota-connection-note">{t('shell.connect.terminalPrompt')}</p>
              <p className="quota-connect-cmd"><code className="set-mono">{login.command}</code>{login.hintKey ? <span className="quota-connect-cmd-hint"> {t(login.hintKey)}</span> : null}</p>
            </>
          ) : (
            <p className="quota-connection-note">{login.noteKey ? t(login.noteKey) : null}</p>
          )}
          {connection === 'accessDenied' && <p className="quota-connection-note">{t('shell.connect.allowKeychain')}</p>}
          <button type="button" className="set-text-button" onClick={onRefresh}>{t('shell.action.refresh')}</button>
        </div>
      )}
    </div>
  )
}
