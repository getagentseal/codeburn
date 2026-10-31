export type QuotaWindow = { label: string; usedPct: number; resetsAt?: string }

/// The glance value: every provider on the same billing horizon, weekly if there is one, else
/// monthly, else the window nearest exhaustion. Empty stays null rather than posing as 0%.
export function headlineWindow(windows: QuotaWindow[]): QuotaWindow | null {
  const find = (needle: string) =>
    windows.find((row) => !row.label.includes('·') && row.label.toLowerCase().includes(needle))
  return (
    find('week') ??
    find('month') ??
    find('5-hour') ??
    windows.reduce<QuotaWindow | null>((worst, row) => (worst && worst.usedPct >= row.usedPct ? worst : row), null)
  )
}
