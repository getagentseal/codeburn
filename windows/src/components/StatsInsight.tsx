import { useState } from 'react'
import type { MenubarPayload, ProjectEntry, SessionDetailEntry } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency, formatCompactCurrency, formatTokens, plural } from '../lib/currency'
import { daysInMonth, monthDay } from '../lib/dates'
import { computeHistoryStats } from '../lib/history'
import type { Period } from './PeriodTabs'
import { ArrowDownRight, ArrowUpRight, ChevronRight, FlameIcon } from './Icons'
import { formatCompactSessionCount, formatSessionCount, SESSION_COUNT_HELP } from '../lib/session-count-label'

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
  period: Period
}

const PERIOD_SUFFIX: Record<Period, string> = {
  today: 'today',
  week: '(7 days)',
  '30days': '(30 days)',
  month: '(month)',
  all: '(6 months)',
  lifetime: '(all time)',
}

/// The CLI sends a full path; only the last segment identifies the repository to a reader.
function projectDisplayName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

export function StatsInsight({ payload, currency, period }: Props) {
  const s = computeHistoryStats(payload.history.daily)
  const suffix = PERIOD_SUFFIX[period]
  const projects = (payload.current.topProjects ?? []).slice(0, 3)
  const costliest = payload.current.topSessions?.[0]

  return (
    <div className="stats-insight">
      <div className="stats-grid">
        <div className="stats-col">
          <StatRow label="Favorite model" value={payload.current.topModels[0]?.name ?? '-'} />
          <StatRow label="Active days (month)" value={`${s.activeDaysThisMonth}/${daysInMonth(new Date())}`} />
          <StatRow label="Most active day" value={s.peak ? monthDay(s.peak.date) : '-'} />
          <StatRow label="Peak day spend" value={s.peak ? formatCompactCurrency(s.peak.cost, currency) : '-'} />
        </div>
        <div className="stats-col">
          <StatRow label={`Sessions ${suffix}`} value={formatSessionCount(payload.current.sessions, payload.current.sessionCountBasis)} />
          <StatRow label={`Calls ${suffix}`} value={payload.current.calls.toLocaleString()} />
          <StatRow label="Current streak" value={s.currentStreak > 0 ? plural(s.currentStreak, 'day') : '-'} />
          <StatRow label="Longest streak" value={s.longestStreak > 0 ? plural(s.longestStreak, 'day') : '-'} />
        </div>
      </div>
      {s.trackedDays > 0 && (
        <div className="stats-lifetime">
          <span className="stats-lifetime-label">
            Tracked spend (last {plural(s.trackedDays, 'day')})
          </span>
          <span className="stats-lifetime-value">
            {formatCurrency(s.trackedTotal, currency)}
          </span>
        </div>
      )}
      {projects.length > 0 && <TopProjects projects={projects} currency={currency} />}
      {costliest && costliest.cost > 0 && (
        <div className="stats-costliest">
          <FlameIcon size={9} className="stats-costliest-icon" />
          <span className="stats-costliest-label">Costliest session</span>
          <span className="stats-spacer" />
          <span className="stats-costliest-value">{formatCompactCurrency(costliest.cost, currency)}</span>
          <span className="stats-costliest-project">· {projectDisplayName(costliest.project)}</span>
        </div>
      )}
    </div>
  )
}

/// Port of TopProjectsList: the three dearest repositories, each opening onto its own
/// sessions. One row can be open at a time, so the block never grows past a screenful.
function TopProjects({ projects, currency }: { projects: ProjectEntry[]; currency: CurrencyState }) {
  const [open, setOpen] = useState<string | null>(null)
  const maxCost = Math.max(projects[0]?.cost ?? 1, 0.01)

  return (
    <div className="stats-projects">
      {projects.map((project, index) => {
        const key = `${index}:${project.name}`
        const isOpen = open === key
        return (
          <div key={key}>
            <button
              type="button"
              className="project-row"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : key)}
            >
              <ChevronRight size={7} className={`chevron ${isOpen ? 'chevron-open' : ''}`} />
              <span className="project-name">{projectDisplayName(project.name)}</span>
              <span className="stats-spacer" />
              <span className="project-sessions" title={project.sessionCountBasis === 'identity' ? undefined : SESSION_COUNT_HELP}>{formatCompactSessionCount(project.sessions, project.sessionCountBasis)}</span>
              <span className="project-cost">{formatCompactCurrency(project.cost, currency)}</span>
              <span className="project-bar" style={{ width: `${Math.max(2, 40 * (project.cost / maxCost))}px` }} />
            </button>
            {isOpen && (project.sessionDetails?.length ?? 0) > 0 && (
              <SessionList sessions={project.sessionDetails ?? []} currency={currency} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function SessionList({ sessions, currency }: { sessions: SessionDetailEntry[]; currency: CurrencyState }) {
  return (
    <div className="session-list">
      {sessions.slice(0, 5).map((session, index) => (
        <div key={`${session.date}-${index}`} className="session-row">
          <div className="session-line">
            <span className="session-cost">{formatCompactCurrency(session.cost, currency)}</span>
            <span className="session-calls">{plural(session.calls, 'call')}</span>
            <span className="stats-spacer" />
            <span className="session-tokens">
              <ArrowDownRight size={7} />{formatTokens(session.inputTokens)}
            </span>
            <span className="session-tokens">
              <ArrowUpRight size={7} />{formatTokens(session.outputTokens)}
            </span>
          </div>
          {(session.models?.length ?? 0) > 0 && (
            <div className="session-models">
              {(session.models ?? []).slice(0, 3).map(model => (
                <span key={model.name} className="session-model">{model.name}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <div className="stat-row-label">{label}</div>
      <div className="stat-row-value">{value}</div>
    </div>
  )
}
