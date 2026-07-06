import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type Column = { key: string; label: string; num?: boolean }

export function DataTable({ columns, rows }: { columns: Column[]; rows: Array<Record<string, ReactNode>> }) {
  if (!rows.length) return <div className="py-8 text-center text-sm text-tertiary-foreground">No data.</div>
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              className={cn(
                'pb-2 text-[11px] font-medium uppercase tracking-wider text-tertiary-foreground',
                c.num ? 'text-right' : 'text-left',
              )}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border">
            {columns.map((c) => (
              <td key={c.key} className={cn('py-2 tabular-nums', c.num ? 'text-right' : 'text-left')}>
                {r[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
