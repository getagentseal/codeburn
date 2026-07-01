import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  fetchContextSessions,
  fetchContextTree,
  type ContextProvider,
  type ContextRow,
  type ContextSessionInfo,
} from '@/lib/api'
import { cn, fmtNum, fmtTokens, label } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

const PROVIDERS: Array<{ key: ContextProvider; label: string }> = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
]

function ago(mtimeMs: number): string {
  const mins = Math.max(0, Math.round((Date.now() - mtimeMs) / 60_000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / (60 * 24))}d ago`
}

function TreeTable({ rows }: { rows: ContextRow[] }) {
  const max = Math.max(1, ...rows.filter((r) => !r.bold).map((r) => r.tokens))
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => (
        <div key={i} className={cn('relative flex items-center gap-3 rounded-sm px-2 py-[3px]', r.bold && i > 0 && 'mt-2')}>
          {!r.bold && (
            <span
              className="absolute inset-y-[3px] left-0 rounded-sm bg-primary/[0.07]"
              style={{ width: `${Math.max(1, (r.tokens / max) * 100)}%` }}
            />
          )}
          <span
            className={cn('relative min-w-0 flex-1 truncate text-[13px]', r.bold ? 'font-semibold text-foreground' : 'text-muted-foreground')}
            style={{ paddingLeft: r.depth * 16 }}
          >
            {r.label}
          </span>
          <span className="relative w-16 shrink-0 text-right text-xs tabular-nums text-tertiary-foreground">{fmtNum(r.count)}x</span>
          <span className={cn('relative w-20 shrink-0 text-right text-[13px] tabular-nums', r.bold ? 'font-semibold text-foreground' : 'text-foreground')}>
            {fmtTokens(r.tokens)}
          </span>
        </div>
      ))}
    </div>
  )
}

function Chip({ label: lbl, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-interactive-secondary px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-tertiary-foreground">{lbl}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{value}</div>
    </div>
  )
}

function SessionDetails({ provider, id }: { provider: ContextProvider; id: string }) {
  const [scope, setScope] = useState<'effective' | 'full'>('effective')
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['context-tree', provider, id],
    queryFn: () => fetchContextTree(provider, id),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-4 py-4">
        <Skeleton className="h-14" />
        <Skeleton className="h-40" />
        <p className="text-xs text-tertiary-foreground">Reading the whole transcript, large sessions take a few seconds…</p>
      </div>
    )
  }
  if (isError || !data) {
    return <p className="px-4 py-4 text-sm text-tertiary-foreground">Failed to load: {String((error as Error)?.message ?? 'unknown')}</p>
  }

  const view = scope === 'full' ? data.full : data.effective
  const rows = scope === 'full' ? data.fullRows : data.effectiveRows
  const window = data.reported?.window ?? null
  const pct = data.reported && window ? Math.min(100, Math.round((data.reported.context / window) * 100)) : null

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Chip label="Messages" value={fmtNum(view.messages)} />
        <Chip label="Est. tokens" value={fmtTokens(view.tokens)} />
        <Chip
          label="Context (exact)"
          value={data.reported ? (window ? `${fmtTokens(data.reported.context)} / ${fmtTokens(window)}` : fmtTokens(data.reported.context)) : '—'}
        />
        <Chip label="Compactions" value={fmtNum(data.compactions)} />
      </div>

      {pct !== null && (
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-tertiary-foreground">
            <span>{label(data.model)} · live context window</span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-interactive-secondary">
            <div className={cn('h-full rounded-full', pct >= 80 ? 'bg-[#c8541f]' : 'bg-primary')} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex rounded-md border border-border bg-interactive-secondary p-0.5">
          {(['effective', 'full'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn(
                'rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition-colors',
                scope === s ? 'bg-active-primary text-foreground shadow-sm' : 'text-tertiary-foreground hover:text-foreground',
              )}
            >
              {s === 'effective' ? 'Live window' : 'Full history'}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-tertiary-foreground">token counts are estimates; “Context (exact)” comes from API usage</span>
      </div>

      <TreeTable rows={rows} />
    </div>
  )
}

function SessionRow({ s, open, onToggle }: { s: ContextSessionInfo; open: boolean; onToggle: () => void }) {
  return (
    <div className={cn('border-t border-border first:border-t-0', open && 'bg-interactive-secondary/30')}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-interactive-secondary/50">
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          className={cn('shrink-0 text-tertiary-foreground transition-transform', open && 'rotate-90')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 3l5 5-5 5" />
        </svg>
        <span className="shrink-0 font-mono text-xs text-primary">{s.sessionId.slice(0, 8)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
          {s.title || <span className="text-tertiary-foreground">untitled session</span>}
        </span>
        <span className="hidden shrink-0 text-xs text-tertiary-foreground sm:block">{s.project}</span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-tertiary-foreground">{ago(s.mtimeMs)}</span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-tertiary-foreground">{(s.sizeBytes / 1024 / 1024).toFixed(1)}MB</span>
      </button>
      {open && (
        <div className="border-t border-border">
          <SessionDetails provider={s.provider} id={s.sessionId} />
        </div>
      )}
    </div>
  )
}

export function ContextExplorer() {
  const [provider, setProvider] = useState<ContextProvider>('claude')
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['context-sessions', provider],
    queryFn: () => fetchContextSessions(provider),
    staleTime: 30_000,
  })

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => {
              setProvider(p.key)
              setOpenId(null)
            }}
            className={cn(
              'rounded-md border px-3.5 py-1.5 text-xs font-medium transition-colors',
              provider === p.key
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-card text-tertiary-foreground hover:text-foreground',
            )}
          >
            {p.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-tertiary-foreground">what fills each session’s context window, block by block</span>
      </div>

      <Card className="overflow-hidden">
        {isLoading && (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        )}
        {isError && <p className="px-4 py-6 text-sm text-tertiary-foreground">Failed to load sessions: {String((error as Error)?.message)}</p>}
        {data && data.length === 0 && <p className="px-4 py-6 text-sm text-tertiary-foreground">No sessions found for this provider.</p>}
        {data?.map((s) => (
          <SessionRow key={s.sessionId} s={s} open={openId === s.sessionId} onToggle={() => setOpenId(openId === s.sessionId ? null : s.sessionId)} />
        ))}
      </Card>
    </>
  )
}
