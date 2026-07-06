export type BarItem = { name: string; value: number; display: string }

export function BarList({ items, total }: { items: BarItem[]; total?: number }) {
  if (!items.length) return <div className="py-8 text-center text-sm text-tertiary-foreground">No data.</div>
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((it) => {
        const pct = Math.max(2, Math.round((it.value / max) * 100))
        const share = total ? Math.round((it.value / total) * 100) + '%' : ''
        return (
          <div key={it.name} className="grid grid-cols-[minmax(80px,130px)_1fr_auto] items-center gap-3 text-sm">
            <div className="truncate text-foreground">{it.name}</div>
            <div className="h-2 overflow-hidden rounded-full bg-interactive-secondary">
              <div
                className="h-full rounded-full"
                style={{ width: pct + '%', background: 'linear-gradient(90deg, var(--color-chart-1), var(--color-chart-4))' }}
              />
            </div>
            <div className="min-w-[88px] text-right tabular-nums text-tertiary-foreground">
              <span className="font-medium text-foreground">{it.display}</span> {share}
            </div>
          </div>
        )
      })}
    </div>
  )
}
