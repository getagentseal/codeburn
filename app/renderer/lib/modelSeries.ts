export type SeriesKey = 'flagship' | 'premium' | 'balanced' | 'fast' | 'other'

export const SERIES_LABELS: Record<SeriesKey, string> = {
  flagship: 'Flagship',
  premium: 'Premium',
  balanced: 'Balanced',
  fast: 'Fast',
  other: 'Other',
}

const SERIES_CSS_VAR: Record<SeriesKey, string> = {
  flagship: 'var(--s-flagship)',
  premium: 'var(--s-premium)',
  balanced: 'var(--s-balanced)',
  fast: 'var(--s-fast)',
  other: 'var(--s-other)',
}

const SERIES_CLASS: Record<SeriesKey, string> = {
  flagship: 's-flagship',
  premium: 's-premium',
  balanced: 's-balanced',
  fast: 's-fast',
  other: 's-other',
}

export function seriesKeyForModel(model?: string): SeriesKey {
  const m = (model ?? '').toLowerCase()
  if (/\bgpt[-\s]?5\.6[-\s]?sol\b/.test(m)) return 'flagship'
  if (/\bgpt[-\s]?5\.6[-\s]?luna\b/.test(m)) return 'fast'
  if (/\bgpt[-\s]?5\.6[-\s]?terra\b/.test(m)) return 'balanced'
  if (m.includes('gemini')) {
    if (m.includes('flash')) return 'fast'
    if (m.includes('pro')) return 'balanced'
  }
  if (m.includes('opus')) return 'flagship'
  if (m.includes('fable')) return 'premium'
  if (m.includes('sonnet')) return 'balanced'
  if (m.includes('haiku')) return 'fast'
  if (m.includes('gpt') || m.includes('codex')) return 'balanced'
  return 'other'
}

export function seriesColorForModel(model?: string): string {
  return SERIES_CSS_VAR[seriesKeyForModel(model)]
}

export function seriesClassForModel(model?: string): string {
  return SERIES_CLASS[seriesKeyForModel(model)]
}

export function seriesClassForKey(series: SeriesKey): string {
  return SERIES_CLASS[series]
}

export function isOtherNode(idOrLabel?: string): boolean {
  const value = (idOrLabel ?? '').trim().toLowerCase()
  return value === '__other__' || value === 'other' || value === 'others'
}
