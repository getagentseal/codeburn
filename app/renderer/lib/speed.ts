/** Local timing metadata only; never includes prompts, completions or credentials. */
export const SPEED_HARNESSES = ['codex', 'claude', 'zcode', 'dsh', 'hermes', 'antigravity'] as const
export type SpeedHarness = typeof SPEED_HARNESSES[number]
export const harnessName: Record<SpeedHarness, string> = {
  codex: 'Codex', claude: 'Claude Code', zcode: 'ZCode', dsh: 'DeepSeek Harness', hermes: 'Hermes', antigravity: 'Antigravity',
}
/** Medians for one trend interval; null where the row has no complete request. */
export type SpeedTrendPoint = {
  generationTokensPerSecondP50: number | null
  generationRequests: number
  firstEmissionMsP50: number | null
  firstEmissionRequests: number
} | null
/** Median day before the report window, and the window's change against it. */
export interface SpeedTypical {
  days: number
  generationTokensPerSecondP50: number | null
  firstEmissionMsP50: number | null
  generationChangePct: number | null
  firstEmissionChangePct: number | null
  generationShift: boolean
  firstEmissionShift: boolean
}
export interface SpeedRow {
  harness: SpeedHarness
  model: string
  source: 'proxy' | 'native' | 'antigravity-cli' | 'zcode-db' | 'codex-checkpoint'
  resolution: 'token' | 'chunk' | 'request' | 'turn'
  latestStartedAt: string
  latestSampleId: string | null
  estimated: boolean
  generationRateEstimated: boolean
  generationRequests: number
  /** Most request windows were sub-second bursts, so no generation rate is shown. */
  bufferedDelivery?: boolean
  requests: number
  timedRequests: number
  incompleteRequests: number
  outputTokens: number
  effectiveTokensPerSecond: number | null
  generationTokensPerSecondP50: number | null
  firstEmissionMsP50: number | null
  durationMsP95: number | null
  /** Aligned with `SpeedReport.trend.starts`. */
  trend: SpeedTrendPoint[]
  typical: SpeedTypical | null
}
export interface SpeedReport {
  rows: SpeedRow[]
  trend: { bucket: 'hour' | 'day' | 'week'; starts: string[] }
  typicalDays: number | null
  unavailableHarnesses: SpeedHarness[]
  rejectedRecords: number
  omittedRecords: number
  warnings: string[]
  generatedAt: string
  historyLimit: number
}
export interface SpeedSample {
  id: string
  harness: SpeedHarness
  model: string
  source: SpeedRow['source']
  resolution: SpeedRow['resolution']
  startedAt: string
  durationMs: number
  firstEmissionMs?: number
  outputTokens?: number
  status: 'complete' | 'incomplete' | 'interrupted' | 'error'
  events: Array<{ elapsedMs: number; tokens?: 1 }>
  timelineTruncated?: boolean
}
