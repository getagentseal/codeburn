import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { ACCEPTS_KEY, refreshQuota, summaryFor, type Connection, type QuotaState } from '../lib/quota'
import { QUOTA_CADENCES, subscribeSettings, writeSettings, type AppSettings } from '../lib/appSettings'
import { homePath } from '../lib/platform'
import { Field, Group, Note, Pane, Row, Select, Switch } from './controls'
import { CheckCircleIcon, KeySlashIcon, RetryIcon, WarningIcon, XIcon } from '../components/Icons'

/// One pane per provider the CLI has a live quota adapter for, from the mac's
/// ClaudeSettingsTab / CodexSettingsTab / ... and GenericProviderSettingsTab.
///
/// The Windows side has one connection story for all ten: `codeburn quota` reads whatever
/// credential the provider's own app or CLI already wrote, so there is nothing to connect
/// and nothing to disconnect. What the mac spells as Connect / Disconnect / Reconnect is
/// Retry here, plus the instruction that says where the credential is supposed to come from.

/// ProviderConnectionGuidance.instruction, resolved per provider rather than from a catalog
/// of auth methods this app does not carry.
const GUIDANCE: Record<string, string> = {
  claude: 'Sign in to Claude Code (run `claude` and type /login), then click Retry.',
  codex: 'Run `codex login` and choose a ChatGPT plan, then click Retry.',
  gemini: 'Run the Gemini CLI once to sign in, then click Retry.',
  copilot: 'Sign in with the Copilot CLI or an editor Copilot plugin, then click Retry.',
  antigravity: 'Start the Antigravity app, then click Retry.',
  kimi: 'Sign in with the Kimi CLI, then click Retry.',
  cursor: 'Sign in to the Cursor app, then click Retry.',
  zai: 'Sign in with the Pi CLI, or set ZAI_API_KEY, then click Retry.',
  grok: 'Sign in with the Grok CLI, then click Retry.',
  clinepass: 'Sign in with Cline (run `cline auth`), or set CLINEPASS_API_KEY, then click Retry.',
  devin: 'Run the Devin CLI once to sign in, then click Retry.',
  commandcode: 'Sign in with the Command Code CLI, then click Retry.',
}

/// The mac's "How it works" sections, with the Windows paths. Every one of these is
/// read-only: nothing is copied into a store of CodeBurn's own.
const HOW_IT_WORKS: Record<string, string> = {
  claude: 'Claude quota is read from the Claude Code credentials already on this machine, then checked against Anthropic. Only the plan and the rate-limit windows come back; no conversation content is read.',
  codex: 'Codex quota follows the authoritative %USERPROFILE%\\.codex\\auth.json session directly. Only ChatGPT-mode auth (Plus, Pro, Team, Business, Edu, Enterprise) reports rate-limit windows; API-key users are billed per request and have a different reporting surface. Credit-metered workspaces report their monthly credit allowance instead.',
  gemini: 'Gemini quota reads %USERPROFILE%\\.gemini\\oauth_creds.json read-only and asks Google Code Assist. Tokens stay in memory. If it shows as expired, run the Gemini CLI once to refresh your login, then click Retry.',
  copilot: 'Copilot quota reads a GitHub token that is already on this machine, read-only: the editor plugin files under %LOCALAPPDATA%\\github-copilot first, then the Copilot CLI files. Usage tracking works without any of this; only the live quota bars need a token.',
  antigravity: 'Antigravity quota talks to the local Antigravity language server on 127.0.0.1 only. Nothing leaves the machine and no credential files are read. If it shows as disconnected, start the Antigravity app, then click Retry.',
  kimi: 'Kimi Code quota reads %USERPROFILE%\\.kimi-code\\credentials\\kimi-code.json directly. Access tokens are short-lived and only the Kimi CLI refreshes them, so if the connection shows as expired, run the Kimi CLI once and click Retry.',
  cursor: 'Cursor quota opens the Cursor editor state database read-only for its access token, then asks cursor.com. Nothing is written back, so an expired token can only be refreshed by signing in to Cursor again.',
  zai: 'Z.ai quota uses a supplied API key if there is one, and otherwise the Z.ai login the Pi CLI keeps in %USERPROFILE%\\.pi\\agent\\auth.json.',
  grok: 'Grok Build quota reads %USERPROFILE%\\.grok\\auth.json, preferring the current OIDC scope over an older sign-in entry.',
  clinepass: 'ClinePass quota uses CLINEPASS_API_KEY or CLINE_API_KEY if set, and otherwise the Cline sign-in in %USERPROFILE%\\.cline\\data\\settings\\providers.json, read-only. Only Cline refreshes that sign-in, so if it shows as expired, run cline once and click Retry.',
  devin: 'Devin quota reads the plan status the Devin CLI caches in %USERPROFILE%\\.cache\\devin\\cli, read-only. Nothing is sent anywhere and no API key is used, so the numbers are as fresh as the CLI\'s last run.',
  commandcode: 'Command Code quota reads the API key the Command Code CLI keeps in %USERPROFILE%\\.commandcode\\auth.json, read-only, and asks Command Code for the 5-hour and weekly windows and the credits left.',
}

type Props = {
  id: string
  name: string
  quota: QuotaState
}

export function ProviderPane({ id, name, quota }: Props) {
  const summary = summaryFor(quota, id)
  const connection: Connection | null = summary?.connection ?? null
  const guidance = GUIDANCE[id] ?? 'Sign in with the provider app or CLI, then click Retry.'

  const title =
    connection === 'connected' ? 'Connected'
      : connection === 'stale' ? 'Refreshing...'
        : connection === 'loading' ? 'Connecting...'
          : connection === 'transientFailure' ? 'Retrying'
            : connection === 'terminalFailure' ? 'Reconnect required'
              : 'Not connected'

  const detail =
    connection === 'connected' || connection === 'stale'
      ? (summary?.planLabel ? `Plan: ${summary.planLabel}` : 'Live quota is available to the popover and the Capacity Dock.')
      : connection === 'transientFailure'
        ? quota.error ?? 'The last refresh failed; the next one is already scheduled.'
        : connection === 'terminalFailure'
          ? [summary?.reason, guidance].filter(Boolean).join(' ')
          : quota.providers.length === 0
            ? 'Waiting for the first quota reading.'
            : guidance

  return (
    <Pane>
      <Group title="Connection" footer={`CodeBurn reads whatever credential ${name} already wrote on this machine. It never copies one into a store of its own.`}>
        <div className="stg-row">
          <div className="stg-conn">
            <span className={`stg-conn-icon stg-conn-${connection ?? 'disconnected'}`}>
              {connection === 'connected' || connection === 'stale' ? <CheckCircleIcon size={16} />
                : connection === 'terminalFailure' ? <WarningIcon size={16} />
                  : connection === 'transientFailure' ? <RetryIcon size={16} />
                    : <KeySlashIcon size={16} />}
            </span>
            <div className="stg-row-text">
              <div className="stg-row-label">{title}</div>
              <div className="stg-row-hint">{detail}</div>
            </div>
          </div>
          <div className="stg-row-control">
            <button
              type="button"
              className={`btn ${quota.loading ? 'btn-spinning' : ''}`}
              disabled={quota.loading}
              onClick={() => { void refreshQuota() }}
            >
              {quota.loading ? 'Checking...' : 'Retry'}
            </button>
          </div>
        </div>
        {summary && summary.windows.length > 0 && (
          <Note>
            {summary.windows.map(window => `${window.label} ${Math.round(window.usedPct)}%`).join('  ·  ')}
          </Note>
        )}
      </Group>

      {id === 'claude' && <ClaudeConfigDirs />}

      {id === 'cursor' && <CursorSync />}

      {ACCEPTS_KEY.includes(id) && <ProviderKey id={id} name={name} />}

      <QuotaCadence />

      <Group title="How it works">
        <Note>{HOW_IT_WORKS[id] ?? `${name} quota comes from the codeburn CLI, which reads the credential the provider's own tools left on this machine.`}</Note>
      </Group>
    </Pane>
  )
}

/// The mac's ClaudeConfigDirsSection. Persisted to the CLI's own config, so every `codeburn`
/// run aggregates the same set whether this app spawned it or the user typed it.
function ClaudeConfigDirs() {
  const [dirs, setDirs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke<string[]>('claude_config_dirs').then(setDirs).catch(() => {})
  }, [])

  const apply = async (next: string[]) => {
    setError(null)
    try {
      setDirs(await invoke<string[]>('set_claude_config_dirs', { dirs: next }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const add = async () => {
    const picked = await invoke<string | null>('pick_directory', {
      title: 'Choose a Claude config directory (one containing a projects folder).',
    }).catch(() => null)
    if (!picked || dirs.includes(picked)) return
    void apply([...dirs, picked])
  }

  return (
    <Group
      title="Config Directories"
      footer={`Aggregate usage across several Claude config directories, for instance work and personal accounts. Empty tracks just the default ${homePath('.claude')}. The CLAUDE_CONFIG_DIRS environment variable, when set, overrides this list.`}
    >
      {dirs.length === 0 ? (
        <Note>No extra directories. Tracking the default {homePath('.claude')}.</Note>
      ) : (
        dirs.map((dir, index) => (
          <Row
            key={dir}
            label={<span className="stg-path">{dir}</span>}
            control={
              <button
                type="button"
                className="btn btn-icon"
                title="Remove"
                aria-label={`Remove ${dir}`}
                onClick={() => apply(dirs.filter((_, i) => i !== index))}
              >
                <XIcon size={11} />
              </button>
            }
          />
        ))
      )}
      {error && <Note><span className="stg-error">{error}</span></Note>}
      <Row control={<button type="button" className="btn" onClick={add}>Add Directory...</button>} />
    </Group>
  )
}

/// The CLI's `cursorSync` config key. The status line lives in the popover's Cursor tab.
function CursorSync() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [envOff, setEnvOff] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke<boolean>('cursor_sync').then(setEnabled).catch(() => {})
    invoke<boolean>('cursor_sync_env_off').then(setEnvOff).catch(() => {})
  }, [])

  const toggle = async () => {
    setError(null)
    try {
      setEnabled(await invoke<boolean>('set_cursor_sync', { enabled: !enabled }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (enabled === null) return null
  return (
    <Group title="Usage Sync" footer="CodeBurn downloads your own usage export with the Cursor app's login, at most once an hour.">
      <Row
        label="Sync Cursor usage from cursor.com"
        hint={enabled && envOff ? 'Turned off by CODEBURN_CURSOR_SYNC=0' : undefined}
        control={<Switch on={enabled && !envOff} disabled={enabled && envOff} onToggle={() => { void toggle() }} ariaLabel="Sync Cursor usage from cursor.com" />}
      />
      {error && <Note><span className="stg-error">{error}</span></Note>}
    </Group>
  )
}

/// The mac keeps its pasted keys in a CodeBurn-owned Keychain item. Here they are sealed with
/// DPAPI under %LOCALAPPDATA%\codeburn and handed to the CLI as environment variables on the
/// child process, because the CLI has no credential store of its own. The key is never read
/// back into this window: all it learns is whether one is stored.
function ProviderKey({ id, name }: { id: string; name: string }) {
  const [stored, setStored] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke<string[]>('provider_key_providers').then(setStored).catch(() => {})
  }, [])

  const save = async (key: string) => {
    setBusy(true)
    setError(null)
    try {
      setStored(await invoke<string[]>('set_provider_key', { provider: id, key }))
      setDraft('')
      void refreshQuota()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const has = stored.includes(id)

  return (
    <Group
      title="API key"
      footer="On Windows the key is encrypted for this account with DPAPI, so the file is worthless on another machine or under another sign-in; on Linux it sits in a file only your user can read. It is passed to the codeburn CLI as an environment variable and is never written to a command line or a log."
    >
      <Row
        label={has ? 'A key is stored' : 'No key stored'}
        hint={has ? `${name} quota is read with the key saved on this machine.` : `Paste a ${name} API key to read live quota.`}
        control={
          <button type="button" className="btn" disabled={!has || busy} onClick={() => save('')}>
            Clear
          </button>
        }
      />
      <Row
        stacked
        label="Paste a key"
        control={
          <>
            <Field
              secure
              ariaLabel={`${name} API key`}
              placeholder={has ? 'Replace the stored key' : 'API key'}
              value={draft}
              onChange={setDraft}
              width={280}
            />
            <button
              type="button"
              className="btn btn-prominent"
              disabled={busy || draft.trim().length === 0}
              onClick={() => save(draft)}
            >
              Save and Connect
            </button>
          </>
        }
      />
      {error && <Note><span className="stg-error">{error}</span></Note>}
    </Group>
  )
}

/// SubscriptionRefreshCadence. One `codeburn quota` run answers for every provider, so this
/// is deliberately one setting shown on each pane rather than ten that could disagree.
function QuotaCadence() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => subscribeSettings(setSettings), [])
  if (!settings) return null

  return (
    <Group title="Quota Refresh">
      <Row
        label="Update every"
        control={
          <Select
            ariaLabel="Quota refresh cadence"
            value={settings.quotaCadenceSeconds}
            options={QUOTA_CADENCES}
            onChange={quotaCadenceSeconds => writeSettings({ quotaCadenceSeconds })}
          />
        }
      />
      <Note>
        Providers rate-limit these endpoints per account, and one run answers for all of them,
        so this cadence covers every provider. Manual only refreshes when you open the popover
        or press Retry.
      </Note>
    </Group>
  )
}
