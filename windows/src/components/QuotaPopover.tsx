import { displayLabel, pct, resetsIn, severity, type QuotaSummary, type QuotaWindow } from '../lib/quota'
import { t } from '../i18n/index'

/// Port of QuotaDetailPopover in mac/Sources/CodeBurnMenubar/Views/AgentTabStrip.swift: the
/// 260pt card a tab shows on hover. Same four states, same copy.

export function QuotaPopover({ quota }: { quota: QuotaSummary }) {
  if (quota.connection === 'terminalFailure') {
    return (
      <div className="quota-card">
        <div className="quota-reconnect-title">{reconnectTitle(quota)}</div>
        <div className="quota-reconnect-reason">{quota.reason ?? reconnectReason(quota)}</div>
        <div className="quota-reconnect-note">{reconnectInstruction(quota)}</div>
      </div>
    )
  }
  if (quota.connection === 'disconnected') {
    return <div className="quota-card"><div className="quota-note">{disconnectedMessage(quota)}</div></div>
  }
  if (quota.connection === 'loading' && quota.windows.length === 0) {
    return <div className="quota-card"><div className="quota-note">{t('Loading...')}</div></div>
  }
  return (
    <div className="quota-card">
      <div className="quota-head">
        <span className="quota-head-title">{quota.name} usage</span>
        {quota.connection === 'stale' && <span className="quota-flag">{t('stale')}</span>}
        {quota.connection === 'transientFailure' && <span className="quota-flag quota-flag-warn">{t('retrying')}</span>}
        <span className="quota-head-spacer" />
        {quota.planLabel && <span className="quota-plan-pill">{quota.planLabel}</span>}
      </div>
      {quota.windows.map((window, index) => <QuotaRow key={`${window.label}-${index}`} window={window} />)}
      {quota.footerLines.length > 0 && (
        <div className="quota-footer">
          {quota.footerLines.map((line, index) => <div key={index} className="quota-footer-line">{line}</div>)}
        </div>
      )}
    </div>
  )
}

function QuotaRow({ window }: { window: QuotaWindow }) {
  const percent = pct(window.usedPct)
  const resets = resetsIn(window.resetsAt)
  return (
    <div className="quota-row">
      <span className="quota-row-label">{displayLabel(window.label)}</span>
      <span className="quota-row-track">
        <span className={`quota-row-fill is-${severity(window.usedPct)}`} style={{ width: `${Math.max(2, percent)}%` }} />
      </span>
      <span className="quota-row-pct">{percent}%</span>
      {resets && <span className="quota-row-resets">{resets}</span>}
    </div>
  )
}

function disconnectedMessage(quota: QuotaSummary): string {
  if (quota.id === 'codex') return t('Sign in with `codex` (ChatGPT mode) to track quota.')
  if (quota.id === 'claude') return t('Sign in to Claude Code to track quota.')
  return t('Sign in to track quota.')
}

function reconnectTitle(quota: QuotaSummary): string {
  return t('Reconnect %@', quota.name)
}

function reconnectReason(quota: QuotaSummary): string {
  if (quota.id === 'codex') return t('Refresh token rejected by OpenAI.')
  if (quota.id === 'claude') return t('Refresh token rejected by Anthropic.')
  return t('%@ rejected the stored credential.', quota.name)
}

function reconnectInstruction(quota: QuotaSummary): string {
  if (quota.id === 'codex') return t('Run `codex login` in your terminal, then click Reconnect.')
  if (quota.id === 'claude') return t('Open Claude Code in your terminal and type `/login`, then click Reconnect.')
  return t('Sign in to %@ again in your terminal, then click Reconnect.', quota.name)
}
