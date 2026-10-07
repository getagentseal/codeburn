import { api, boot } from './install'

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { setCurrentLocale, resolveSystemLocale, t } from '../i18n'
import { asOfLabel, formatCount, formatUsd, setActiveCurrency } from '../lib/format'
import type { HostMessage } from './channels'
import { money, quotaText, type Figure, type SidebarState, type Summary } from './summary'
import './sidebar.css'

setCurrentLocale(resolveSystemLocale(boot.locale))
document.documentElement.lang = resolveSystemLocale(boot.locale)

const initial: SidebarState = { status: 'loading', error: null, summary: null, workspaceLabel: boot.scope.label, runtimeNote: null }

function useSidebarState(): SidebarState {
  const [state, setState] = useState(initial)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as HostMessage
      if (message?.type === 'summary') setState(message.state as SidebarState)
    }
    window.addEventListener('message', onMessage)
    api.postMessage({ type: 'action', name: 'refresh', arg: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])
  return state
}

function act(name: 'openDashboard' | 'openSection' | 'refresh' | 'openSettings' | 'star' | 'dismissStar', arg?: string) {
  api.postMessage({ type: 'action', name, arg })
}

function Row({ label, figure }: { label: string; figure: Figure | null }) {
  return (
    <div className="cbs-row">
      <span className="cbs-label">{label}</span>
      <span className="cbs-value" title={figure?.estimated ? t('shared.usd.estimated') : undefined}>{figure ? money(figure) : '—'}</span>
    </div>
  )
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section className="cbs-sec" aria-labelledby={id}>
      <h2 className="cbs-h" id={id}>{title}</h2>
      {children}
    </section>
  )
}

function Ranked({ rows }: { rows: Summary['topModels'] }) {
  if (rows.length === 0) return <p className="cbs-empty">{t('ide.sidebar.empty')}</p>
  return (
    <ol className="cbs-list">
      {rows.map(row => (
        <li key={row.name} className="cbs-row">
          <span className="cbs-label cbs-ellipsis" title={row.name}>{row.name}</span>
          <span className="cbs-value">{money(row)}</span>
        </li>
      ))}
    </ol>
  )
}

function Quota({ summary }: { summary: Summary }) {
  if (summary.quota.length === 0) return <p className="cbs-empty">{t('ide.sidebar.noPlans')}</p>
  return (
    <ul className="cbs-list">
      {summary.quota.map(line => {
        const percent = Math.min(100, Math.max(0, Math.round(line.percent * 100)))
        const severity = line.percent >= 0.9 ? 'bad' : line.percent >= 0.7 ? 'warn' : 'ok'
        const text = quotaText(line)
        return (
          <li key={`${line.provider}-${line.label}`} className="cbs-quota">
            <span className="cbs-quota-text">{text}</span>
            <span className={`cbs-track ${severity}`} role="meter" aria-label={text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <i style={{ width: `${percent}%` }} />
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function SidebarApp() {
  const state = useSidebarState()
  const summary = state.summary
  if (summary) setActiveCurrency(summary.currency)
  const busy = state.status === 'loading'
  return (
    <main className="cbs" aria-busy={busy}>
      {state.runtimeNote && <p className="cbs-note" role="status">{state.runtimeNote}</p>}
      {state.status === 'error' && (
        <p className="cbs-note error" role="alert">
          {state.error?.kind === 'not-found' ? t('ide.sidebar.notFound') : t('ide.sidebar.error')}
          {state.error?.message && state.error.kind !== 'not-found' ? <small>{state.error.message}</small> : null}
        </p>
      )}
      {!summary && busy && <p className="cbs-empty" role="status">{t('ide.status.loading')}</p>}
      {summary && (
        <>
          <Section id="cbs-ws" title={state.workspaceLabel ? `${t('ide.sidebar.workspace')} · ${state.workspaceLabel}` : t('ide.sidebar.workspace')}>
            {summary.workspace ? (
              <>
                <Row label={t('common.period.today')} figure={summary.workspace.today} />
                <Row label={t('common.period.week')} figure={summary.workspace.week} />
              </>
            ) : <p className="cbs-empty">{t('ide.sidebar.noWorkspace')}</p>}
          </Section>
          <Section id="cbs-all" title={t('ide.scope.all')}>
            <Row label={t('common.period.today')} figure={summary.today} />
            <Row label={t('common.period.week')} figure={summary.week} />
            <Row label={t('common.period.month')} figure={summary.month} />
          </Section>
          <Section id="cbs-projects" title={t('ide.sidebar.topProjects')}><Ranked rows={summary.topProjects} /></Section>
          <Section id="cbs-models" title={t('ide.sidebar.topModels')}><Ranked rows={summary.topModels} /></Section>
          <Section id="cbs-plans" title={t('shell.nav.plans')}><Quota summary={summary} /></Section>
          <Section id="cbs-optimize" title={t('shell.nav.optimize')}>
            <div className="cbs-row">
              <span className="cbs-label">
                {summary.optimize && summary.optimize.findingCount > 0
                  ? `${formatCount(summary.optimize.findingCount, 'finding')} · ${t('ide.sidebar.savings', { amount: formatUsd(summary.optimize.savingsUSD) })}`
                  : summary.optimize ? t('ide.sidebar.noFindings') : '—'}
              </span>
              {summary.optimize && summary.optimize.findingCount > 0 && (
                <button type="button" className="cbs-link" onClick={() => act('openSection', 'optimize')}>{t('ide.sidebar.review')}</button>
              )}
            </div>
          </Section>
        </>
      )}
      <footer className="cbs-foot">
        <button type="button" className="cbs-btn primary" onClick={() => act('openDashboard')}>{t('ide.status.open')}</button>
        <button type="button" className="cbs-btn" onClick={() => act('refresh')} disabled={busy}>{t('shell.action.refresh')}</button>
        {summary && <span className="cbs-asof" aria-live="polite">{busy ? t('ide.status.loading') : asOfLabel(summary.at)}</span>}
      </footer>
      {state.star && (
        <p className="cbs-star">
          <span>{t('ide.star.prompt')} <button type="button" className="cbs-link" onClick={() => act('star')}>{t('ide.star.cta')}</button></span>
          <button type="button" className="cbs-x" onClick={() => act('dismissStar')} title={t('ide.star.hide')} aria-label={t('ide.star.hide')}>×</button>
        </p>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SidebarApp />
  </StrictMode>,
)
