import type { ReactNode } from 'react'
import type { Current } from '@/lib/api'
import { fmtNum } from '@/lib/utils'

// Median time-to-first-edit is milliseconds; render it compactly (sub-second up
// to hours) so a fast 0.8s and a slow 12m both read at a glance.
function fmtDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)} 秒`
  if (s < 60) return `${Math.round(s)} 秒`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} 时 ${rm} 分` : `${h} 时`
}

// The panel earns its place only when at least one signal carries real data.
// An older peer (or a period with no edit activity and no priced calls) leaves
// every field empty, and the whole panel is hidden so the dashboard renders as
// it did before this block existed.
export function hasWorkflowContent(c: Current): boolean {
  const w = c.workflow
  return (
    w?.correctionRate != null ||
    w?.medianTimeToFirstEditMs != null ||
    (w?.corrections ?? 0) > 0 ||
    c.pricingCoverage != null ||
    (c.topReworkedFiles?.length ?? 0) > 0
  )
}

function Row({ label, hint, value }: { label: string; hint?: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-tertiary-foreground" title={hint}>
        {label}
      </span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  )
}

export function WorkflowPanel({ current }: { current: Current }) {
  const w = current.workflow
  const reworked = current.topReworkedFiles ?? []
  const coverage = current.pricingCoverage

  const correction =
    w?.correctionRate == null ? (
      <span className="text-tertiary-foreground">—</span>
    ) : (
      <>
        <span className="font-medium text-foreground">{Math.round(w.correctionRate * 100)}%</span>
        <span className="text-tertiary-foreground"> · {fmtNum(w.corrections)}</span>
      </>
    )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5">
        <Row
          label="纠正率"
          hint="你纠正 AI 回答的提示占比，以及纠正次数"
          value={correction}
        />
        <Row
          label="首次编辑用时"
          hint="从发出提示到首次文件编辑的中位用时"
          value={
            w?.medianTimeToFirstEditMs == null ? (
              <span className="text-tertiary-foreground">—</span>
            ) : (
              <span className="font-medium text-foreground">{fmtDuration(w.medianTimeToFirstEditMs)}</span>
            )
          }
        />
        {coverage != null && (
          <Row
            label="定价覆盖率"
            hint="已解析出单价的计费调用占比"
            // Floor, never round: near-complete coverage with unpriced calls
            // outstanding must not render as the 100% reserved for genuinely
            // complete pricing.
            value={<span className="font-medium text-foreground">{Math.floor(coverage * 100)}%</span>}
          />
        )}
      </div>

      {reworked.length > 0 && (
        <div className="border-t border-border pt-3">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-tertiary-foreground">改动最频繁</div>
          <div className="flex flex-col gap-1.5">
            {reworked.slice(0, 8).map((f, i) => (
              // Ranked summary rows are stateless and paths can repeat. Include
              // the rank so React keys stay unique without merging counts or
              // requiring a row identity that the payload does not provide.
              <div key={`${f.path}:${i}`} className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-[12.5px] text-foreground" title={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-tertiary-foreground">
                  <span className="font-medium text-foreground">{fmtNum(f.edits)}</span> 次编辑 · {fmtNum(f.sessions)} 会话
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
