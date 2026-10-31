import { join } from 'node:path'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { openDatabase } from '../sqlite.js'
import { billableOutputTokens } from '../models.js'
import { mapWithConcurrency } from '../fs-utils.js'
import { getProvider } from '../providers/index.js'
import type { SpeedSample } from './types.js'

// The ZCode limit applies inside the report window, so a trend over past days
// is not starved by the most recent requests.
export async function readSpeedHistory(limit = 100, zcodePath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), includeTurnEstimates = true,
  window: { start?: number; end?: number } = {}): Promise<{ samples: SpeedSample[]; warnings: string[] }> {
  const samples: SpeedSample[] = []
  const warnings: string[] = []
  try {
    await stat(zcodePath)
    const db = openDatabase(zcodePath)
    try {
      const columns = new Set(db.query<{ name: string }>('PRAGMA table_info(model_usage)').map(r => r.name))
      const optional = (name: string) => columns.has(name) ? name : `NULL AS ${name}`
      const rows = db.query<{ id: string; model_id: string; started_at: number; completed_at: number; first_token_at: number | null; output_tokens: number; reasoning_tokens: number; status: string | null }>(
        `SELECT id, model_id, started_at, completed_at, output_tokens, reasoning_tokens, ${optional('first_token_at')}, ${optional('status')}
         FROM model_usage WHERE completed_at > started_at AND output_tokens + reasoning_tokens > 0 AND started_at >= ? AND started_at <= ?
         ORDER BY completed_at DESC LIMIT ?`, [Number.isFinite(window.start) ? window.start : 0, Number.isFinite(window.end) ? window.end : Number.MAX_SAFE_INTEGER, limit])
      // A full page means older requests in the window were left out; say so
      // rather than let them read as idle intervals.
      if (rows.length >= limit) warnings.push(`ZCode history: only the ${limit} most recent requests in this window were read (--history-limit)`)
      for (const row of rows) {
        if (!Number.isFinite(row.started_at) || !Number.isFinite(row.completed_at) || row.started_at <= 0) continue
        const durationMs = row.completed_at - row.started_at
        const firstEmissionMs = row.first_token_at !== null && row.first_token_at >= row.started_at && row.first_token_at <= row.completed_at
          ? row.first_token_at - row.started_at : undefined
        samples.push({ version: 1, id: row.id, harness: 'zcode', model: row.model_id, source: 'zcode-db', resolution: 'request',
          startedAt: new Date(row.started_at).toISOString(), durationMs,
          ...(firstEmissionMs !== undefined ? { firstEmissionMs } : {}),
          outputTokens: billableOutputTokens('zcode', row.output_tokens, row.reasoning_tokens), reasoningTokens: row.reasoning_tokens,
          status: row.status === 'completed' ? 'complete' : row.status === null ? 'incomplete' : row.status === 'cancelled' ? 'interrupted' : 'error', events: [] })
      }
    } finally { db.close() }
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('ZCode timing database could not be read') }
  // GUI generation-speed reads do not need to discover/parse Codex turn logs:
  // those lack first-token timing and cannot contribute to the displayed rate.
  if (!includeTurnEstimates) return { samples, warnings }
  try {
    const provider = await getProvider('codex')
    if (provider) {
      const sources = await provider.discoverSessions()
      const dated = await mapWithConcurrency(sources, 4, async source => ({ source, mtime: await stat(source.path).then(s => s.mtimeMs, () => 0) }))
      const seen = new Set<string>()
      for (const { source } of dated.sort((a, b) => b.mtime - a.mtime).slice(0, limit)) {
        const calls = []
        for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
        // A task's active duration is allocated proportionally to its calls.
        // Multiple models in that task have no independently observed timing;
        // exclude those tasks instead of manufacturing a per-model speed.
        const modelsByTurn = new Map<string, Set<string>>()
        for (const call of calls) {
          const key = call.turnId ?? ''
          const models = modelsByTurn.get(key) ?? new Set<string>()
          models.add(call.model); modelsByTurn.set(key, models)
        }
        for (const call of calls) {
          if (!call.activeDurationMs || !call.activeGeneratedTokens || modelsByTurn.get(call.turnId ?? '')!.size > 1) continue
          samples.push({ version: 1, id: call.deduplicationKey, harness: 'codex', model: call.model,
            source: 'codex-checkpoint', resolution: 'turn', startedAt: call.timestamp,
            durationMs: call.activeDurationMs, outputTokens: call.activeGeneratedTokens, status: 'complete', events: [] })
        }
      }
    }
  } catch { warnings.push('Codex checkpoint estimates could not be read') }
  return { samples, warnings }
}
