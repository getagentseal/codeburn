import { useState } from 'react'
import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { SectionSkeleton } from '../components/Skeleton'
import { StaleBanner } from '../components/StaleBanner'
import { usePolled } from '../hooks/usePolled'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { harnessName, SPEED_HARNESSES, type SpeedHarness, type SpeedRow, type SpeedSample } from '../lib/speed'
import type { DateRange, Period } from '../lib/types'
import './Speed.css'

const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 1 })
const source = (row: Pick<SpeedRow, 'source' | 'resolution'>) => `${t(`speed.source.${row.source}`)} · ${t(`speed.resolution.${row.resolution}`)}`

export function Speed(props: { period: Period; provider: string; range?: DateRange | null; refreshToken?: number; ready?: boolean }) {
  // Reset the event inspector together with the filter; an old response must
  // never appear under a newly selected harness or date range.
  return <SpeedReportView key={`${props.period}|${props.provider}|${props.range?.from}|${props.range?.to}`} {...props} />
}

function SpeedReportView({ period, provider, range = null, refreshToken = 0, ready = true }: Parameters<typeof Speed>[0]) {
  const supported = provider === 'all' || SPEED_HARNESSES.includes(provider as SpeedHarness)
  const [selected, setSelected] = useState<SpeedRow | null>(null)
  const report = usePolled(
    () => codeburn.getSpeed(period, provider, range ?? undefined),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready && supported, memoKey: reportMemoKey('speed', period, provider, range), cadence: { slowMs: 60_000 } },
  )
  const setup = <button className="btn btn-s" onClick={() => codeburn.openExternal('https://github.com/getagentseal/codeburn/blob/main/docs/speed.md')}>{t('speed.setup')}</button>
  if (!supported) return <Panel title={t('shell.nav.speed')} right={setup}><EmptyNote>{t('speed.unsupported')}</EmptyNote></Panel>
  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject={t('shell.nav.speed')} />
    return <SectionSkeleton label={t('speed.loading')} rows={4} />
  }
  const data = report.data
  return <>
    {report.error && <StaleBanner error={report.error} />}
    <Panel className="speed-report" title={t('speed.title')} right={setup}>
      <p className="speed-note">{t('speed.scope')}. {t('speed.explanation')}</p>
      {data.rows.length ? <div className="speed-scroll"><table className="speed-table">
        <thead><tr>
          <th>{t('models.headers.model')} / {t('speed.harness')}</th><th>{t('speed.precision')}</th>
          <th>{t('speed.generation')}</th><th>{t('speed.first')}</th>
          <th>{t('speed.duration')}</th><th>{t('speed.samples')}</th><th>{t('speed.timeline')}</th>
        </tr></thead>
        <tbody>{data.rows.map(row => <tr key={`${row.harness}|${row.model}|${row.source}|${row.resolution}`}>
          <td className="speed-model"><b>{row.model}</b><span className="speed-harness">{harnessName[row.harness]}</span></td><td>{source(row)}</td>
          <td className="speed-rate">{row.generationRateEstimated && row.generationTokensPerSecondP50 != null ? '~' : ''}{number(row.generationTokensPerSecondP50)}</td>
          <td>{number(row.firstEmissionMsP50)}</td><td>{number(row.durationMsP95)}</td>
          <td>{row.generationRequests} / {row.requests}</td>
          <td>{row.latestSampleId ? <button className="btn btn-s" aria-label={`${t('speed.timeline')}: ${harnessName[row.harness]} / ${row.model}`} onClick={() => setSelected(row)}>{t('speed.inspect')}</button> : '—'}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyNote>{t('speed.empty')}</EmptyNote>}
      <p className="speed-note">{t('speed.precisionNote')}</p>
      <p className="speed-note">{t('speed.historyNote', { count: data.historyLimit })}</p>
      {data.unavailableHarnesses.length > 0 && <p className="speed-note">{t('speed.missing', { harnesses: data.unavailableHarnesses.map(h => harnessName[h]).join(', ') })}</p>}
      {(data.rejectedRecords > 0 || data.omittedRecords > 0) && <p role="status" className="speed-note">{t('speed.bounded', { rejected: data.rejectedRecords, omitted: data.omittedRecords })}</p>}
      {data.warnings.map((warning, index) => <p className="speed-note" role="status" key={index}>{warning}</p>)}
    </Panel>
    {selected?.latestSampleId && <SpeedTimeline key={`${selected.harness}|${selected.latestSampleId}`} id={selected.latestSampleId} harness={selected.harness} />}
  </>
}

function SpeedTimeline({ id, harness }: { id: string; harness: SpeedHarness }) {
  const sample = usePolled(() => codeburn.getSpeedEvents(id, harness), [id, harness], { intervalMs: null })
  if (!sample.data) {
    if (sample.error) return <CliErrorPanel error={sample.error} subject={t('speed.timeline')} />
    return <SectionSkeleton label={t('speed.loading')} rows={2} />
  }
  const data = sample.data
  return <Panel className="speed-timeline" title={`${harnessName[data.harness]} / ${data.model}`} right={source(data)}>
    <p className="speed-note">{new Date(data.startedAt).toLocaleString()} · {t(`speed.status.${data.status}`)}</p>
    <dl className="speed-stats">
      <div><dt>{t('speed.output')}</dt><dd>{number(data.outputTokens)}</dd></div>
      <div><dt>{t('speed.events')}</dt><dd>{number(data.events.length)}</dd></div>
      <div><dt>{t('speed.firstRequest')}</dt><dd>{number(data.firstEmissionMs)}</dd></div>
      <div><dt>{t('speed.durationRequest')}</dt><dd>{number(data.durationMs)}</dd></div>
    </dl>
    {data.events.length > 0 && <ArrivalChart sample={data} />}
    <p className="speed-note">{t(data.resolution === 'token' ? 'speed.tokenNote' : 'speed.chunkNote')}</p>
    {data.timelineTruncated && <p role="status" className="speed-note">{t('speed.truncated')}</p>}
  </Panel>
}

export function ArrivalChart({ sample }: { sample: SpeedSample }) {
  // Render at most 200 points, including the last event. Full counts and the
  // source's truncation flag stay visible; a chunk never becomes a token.
  const count = Math.min(sample.events.length, 200)
  const points = Array.from({ length: count }, (_, i) => {
    const index = count === 1 ? 0 : Math.round(i * (sample.events.length - 1) / (count - 1))
    const x = 20 + sample.events[index]!.elapsedMs / Math.max(sample.durationMs, 1) * 760
    const y = 130 - index / Math.max(sample.events.length - 1, 1) * 110
    return { x, y, index }
  })
  return <figure className="speed-chart">
    <svg role="img" aria-label={t('speed.chart')} viewBox="0 0 800 160">
      <path d="M20 10 V140 H780" fill="none" stroke="currentColor" opacity="0.25" />
      <polyline points={points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--accent, #7c83ff)" strokeWidth="2" />
      {points.map(p => <circle key={p.index} cx={p.x} cy={p.y} r="3" fill="var(--accent, #7c83ff)"><title>{`${p.index + 1}: ${number(sample.events[p.index]!.elapsedMs)} ms`}</title></circle>)}
      <text x="20" y="157" fill="currentColor" fontSize="11">0 ms</text>
      <text x="780" y="157" textAnchor="end" fill="currentColor" fontSize="11">{number(sample.durationMs)} ms</text>
    </svg>
    <figcaption className="speed-note">{t('speed.chartCaption', { shown: count, total: sample.events.length })}</figcaption>
  </figure>
}
