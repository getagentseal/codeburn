import { useState } from 'react'

import type { QuotaProvider } from '../lib/types'

// The exact terminal login command per provider. No interactive login is
// attempted from the app — we only show the command to copy and a Refresh.
const LOGIN: Record<QuotaProvider['provider'], { command: string; hint?: string }> = {
  claude: { command: 'claude', hint: 'then type /login' },
  codex: { command: 'codex login' },
}

/** Inline "Connect" affordance for a disconnected or access-denied provider: a
 * short status line plus a text-button that expands the copy-paste login
 * command, the keychain-Allow note (access-denied), and a forced Refresh. */
export function ConnectAffordance({ provider, connection, onRefresh }: {
  provider: QuotaProvider['provider']
  connection: 'disconnected' | 'accessDenied'
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const name = provider === 'claude' ? 'Claude' : 'Codex'
  const message = connection === 'accessDenied'
    ? 'Keychain access needed: click Allow when macOS asks, then Refresh.'
    : `Not connected. Log in with the ${name} CLI.`
  const login = LOGIN[provider]

  return (
    <div className="quota-connect">
      <span className="quota-connection-note">{message}</span>
      <button type="button" className="set-text-button quota-connect-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>Connect</button>
      {open && (
        <div className="quota-connect-guide">
          <p className="quota-connection-note">Sign in from a terminal, then Refresh:</p>
          <p className="quota-connect-cmd"><code className="set-mono">{login.command}</code>{login.hint ? <span className="quota-connect-cmd-hint"> {login.hint}</span> : null}</p>
          {connection === 'accessDenied' && <p className="quota-connection-note">Already logged in? Click Allow when macOS asks for keychain access.</p>}
          <button type="button" className="set-text-button" onClick={onRefresh}>Refresh</button>
        </div>
      )}
    </div>
  )
}
