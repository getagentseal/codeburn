export type SeriesKey = 'opus' | 'fable' | 'sonnet' | 'haiku' | 'gpt' | 'other'

export const SERIES_LABELS: Record<SeriesKey, string> = {
  opus: 'Opus',
  fable: 'Fable',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  gpt: 'GPT / Codex',
  other: 'Other',
}

const SERIES_CSS_VAR: Record<SeriesKey, string> = {
  opus: 'var(--s-opus)',
  fable: 'var(--s-fable)',
  sonnet: 'var(--s-sonnet)',
  haiku: 'var(--s-haiku)',
  gpt: 'var(--s-gpt)',
  other: 'var(--s-other)',
}

const SERIES_CLASS: Record<SeriesKey, string> = {
  opus: 's-opus',
  fable: 's-fable',
  sonnet: 's-son',
  haiku: 's-hai',
  gpt: 's-gpt',
  other: 's-other',
}

export function seriesKeyForModel(model?: string): SeriesKey {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('fable')) return 'fable'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('gpt') || m.includes('codex')) return 'gpt'
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
