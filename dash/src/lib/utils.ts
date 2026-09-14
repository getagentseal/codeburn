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

export function formatSessionCount(sessions: number, basis?: 'identity' | 'partial'): string {
  if (basis !== 'identity') {
    if (sessions <= 0) return '会话数不可用'
    return `至少 ${sessions.toLocaleString()} 次会话`
  }
  return `${sessions.toLocaleString()} 次会话`
}

export function compactUsd(n: number): string {
  if (!isFinite(n)) return '$0'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k'
  return sign + '$' + Math.round(a)
}

// zh-CN display mapping for backend-generated strings (period labels from
// src/cli-date.ts, activity names from src/types.ts CATEGORY_LABELS).
// Unknown values pass through unchanged so newer backends never render blank.

const MONTH_NUMBERS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
}

export function zhPeriodLabel(raw: string): string {
  const m = raw.match(/^(Today|Yesterday) \((.+)\)$/)
  if (m) return (m[1] === 'Today' ? '今天' : '昨天') + ' (' + m[2] + ')'
  if (raw === 'Last 7 Days') return '近7天'
  if (raw === 'Last 30 Days') return '近30天'
  if (raw === 'Last 6 months') return '近6个月'
  if (raw === 'Lifetime') return '全部'
  const mo = raw.match(/^([A-Z][a-z]+) (\d{4})$/)
  if (mo && MONTH_NUMBERS[mo[1]!]) return mo[2] + '年' + MONTH_NUMBERS[mo[1]!] + '月'
  const d = raw.match(/^(\d+) days \((.+)\)$/)
  if (d) return d[1] + ' 天 (' + d[2] + ')'
  return raw
}

const ACTIVITY_LABELS: Record<string, string> = {
  Coding: '编码',
  Debugging: '调试',
  'Feature Dev': '功能开发',
  Refactoring: '重构',
  Testing: '测试',
  Exploration: '探索',
  Planning: '规划',
  Delegation: '委派',
  'Git Ops': 'Git 操作',
  'Build/Deploy': '构建/部署',
  Conversation: '对话',
  Brainstorming: '头脑风暴',
  General: '通用',
}

export function zhActivityLabel(name: string): string {
  return ACTIVITY_LABELS[name] ?? name
}

// Forest green -> gold -> terracotta ramp for stacked series. Referenced as CSS
// custom properties so the palette follows the active theme (light or dark).
export const CHART_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)',
  'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)', 'var(--chart-9)', 'var(--chart-10)',
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
  if (key === 'Other') return '其他'
  if (key === 'unknown') return '未知'
  return key
    .replace(/^gpt-/i, 'GPT-')
    .replace(/-(\d{8,})$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
