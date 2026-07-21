import type { DateRange, Period } from './types'

function rangeKey(range: DateRange | null | undefined): string {
  return `${range?.from ?? ''}-${range?.to ?? ''}`
}

export function sessionsReportKey(period: Period, provider: string, range?: DateRange | null): string {
  return `sessions|${period}|${provider}|${rangeKey(range)}`
}

export function modelsReportKey(period: Period, provider: string, byTask: boolean, range?: DateRange | null): string {
  return `models|${period}|${provider}|${byTask}|${rangeKey(range)}`
}

export function spendFlowReportKey(period: Period, provider: string, range?: DateRange | null): string {
  return `spendflow|${period}|${provider}|${rangeKey(range)}`
}

export function optimizeReportKey(period: Period, provider: string, range?: DateRange | null): string {
  return `optimize|${period}|${provider}|${rangeKey(range)}`
}

export function yieldReportKey(period: Period, provider: string, range?: DateRange | null): string {
  return `yield|${period}|${provider}|${rangeKey(range)}`
}

export function compareModelsReportKey(period: Period, provider: string): string {
  return `comparemodels|${period}|${provider}`
}
