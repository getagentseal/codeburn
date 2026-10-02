/** Local timing metadata only; never includes prompts, completions or credentials. */
export const SPEED_HARNESSES = ['codex', 'claude', 'zcode', 'dsh', 'hermes', 'antigravity'] as const
export type SpeedHarness = typeof SPEED_HARNESSES[number]
export const harnessName: Record<SpeedHarness, string> = {
  codex: 'Codex', claude: 'Claude Code', zcode: 'ZCode', dsh: 'DeepSeek Harness', hermes: 'Hermes', antigravity: 'Antigravity',
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
  requests: number
  timedRequests: number
  incompleteRequests: number
  outputTokens: number
  effectiveTokensPerSecond: number | null
  generationTokensPerSecondP50: number | null
  firstEmissionMsP50: number | null
  durationMsP95: number | null
}
export interface SpeedReport {
  rows: SpeedRow[]
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
