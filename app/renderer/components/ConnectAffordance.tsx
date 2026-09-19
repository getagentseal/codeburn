import { useState } from 'react'

import { PROVIDER_NAMES } from '../lib/providers'
import type { QuotaProvider } from '../lib/types'

// The exact terminal login command per provider. No interactive login is
// attempted from the app — we only show the command to copy and a Refresh.
// Providers without a CLI login (Copilot signs in from an editor plugin;
// Antigravity is local-only) get a note instead of a command.
const LOGIN: Record<QuotaProvider['provider'], { command?: string; hint?: string; note?: string }> = {
  claude: { command: 'claude', hint: 'then type /login' },
  codex: { command: 'codex login' },
  gemini: { command: 'gemini', hint: 'then sign in when prompted' },
  copilot: { note: 'Sign in to GitHub Copilot in your editor (VS Code or JetBrains), then Refresh.' },
  antigravity: { note: 'Open Antigravity and sign in, then Refresh. Quota comes from its local server only.' },
  kimi: { command: 'kimi', hint: 'then sign in when prompted' },
  grokbot: { note: 'Sign in to the Cursor app with the account Grok Bot uses, then Refresh — the weekly allowance is read from that session.' },
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
    ? 'Keychain access needed: click Allow when macOS asks, then Refresh.'
    : `Not connected. Log in with the ${name} CLI.`)
  const login = LOGIN[provider]

  return (
    <div className="quota-connect">
      <span className="quota-connection-note">{message}</span>
      <button type="button" className="set-text-button quota-connect-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>Connect</button>
      {open && (
        <div className="quota-connect-guide">
          {login.command ? (
            <>
              <p className="quota-connection-note">Sign in from a terminal, then Refresh:</p>
              <p className="quota-connect-cmd"><code className="set-mono">{login.command}</code>{login.hint ? <span className="quota-connect-cmd-hint"> {login.hint}</span> : null}</p>
            </>
          ) : (
            <p className="quota-connection-note">{login.note}</p>
          )}
          {connection === 'accessDenied' && <p className="quota-connection-note">Already logged in? Click Allow when macOS asks for keychain access.</p>}
          <button type="button" className="set-text-button" onClick={onRefresh}>Refresh</button>
        </div>
      )}
    </div>
  )
}
