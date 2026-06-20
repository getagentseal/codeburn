import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function usd(n: number | undefined | null): string {
  const v = n == null || !isFinite(n) ? 0 : n
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  const s = a >= 1 || a === 0 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(3) : a.toFixed(2)
  const [int, dec] = s.split('.')
  return sign + '$' + int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '')
}

export function fmtTokens(n: number | undefined | null): string {
  const v = n == null || !isFinite(n) ? 0 : n
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return String(Math.round(v))
}

export function fmtNum(n: number | undefined | null): string {
  const v = n == null || !isFinite(n) ? 0 : n
  return v.toLocaleString()
}

export function compactUsd(n: number): string {
  if (!isFinite(n)) return '$0'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k'
  return sign + '$' + Math.round(a)
}

// Forest green -> gold -> terracotta ramp for stacked series (mirrors the
// --chart-* tokens). Warm and on-brand, distinct enough to read when stacked.
export const CHART_COLORS = [
  '#1f8a5b', '#4fd394', '#2c5242', '#d99a3c', '#c8541f',
  '#2f5fd0', '#7aa86f', '#b5403a', '#3f8f6b', '#a98b4f',
]

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'grok-build-0.1': 'Grok Build',
  'cursor-auto': 'Cursor',
  'composer-2.5': 'Composer 2.5',
}

// Prettify a model id for chart legends. Display-name fields (current.topModels)
// already arrive clean; history rows carry raw ids, so we map the common ones
// and lightly clean the rest.
export function label(key: string): string {
  if (MODEL_LABELS[key]) return MODEL_LABELS[key]
  if (key === 'Other' || key === 'unknown') return key
  return key
    .replace(/^gpt-/i, 'GPT-')
    .replace(/-(\d{8,})$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
