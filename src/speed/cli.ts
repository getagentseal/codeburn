import type { Command } from 'commander'
import { buildSpeedReport, renderSpeedReport } from './report.js'
import { readSpeedHistory } from './history.js'
import { readSpeedSamples, speedFile } from './store.js'
import { isSpeedHarness, SPEED_HARNESSES, type SpeedSample } from './types.js'
import { startSpeedServer } from './server.js'

function integer(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new Error('Limit must be an integer from 1 to 10000')
  return n
}

function port(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('Port must be an integer from 0 to 65535')
  return n
}

export function registerSpeedCommands(program: Command): void {
  const speed = program.command('speed').enablePositionalOptions().description('Local generation speed by model and harness; measured timings and estimates stay separate')
    .option('--json', 'Machine-readable report including coverage and timing percentiles')
    .option('--harness <id>', `Filter a harness (${SPEED_HARNESSES.join(', ')})`)
    .option('--since <date>', 'Include requests started on/after an ISO date or timestamp')
    .option('--file <path>', 'Speed telemetry JSONL file', speedFile())
    .option('--limit <n>', 'Recent telemetry records to read', integer, 10_000)
    .option('--history-limit <n>', 'Recent ZCode requests and Codex sessions to inspect', integer, 100)
    .option('--no-history', 'Read collected telemetry only')
    .action(async opts => {
      if (opts.harness && !isSpeedHarness(opts.harness)) throw new Error('Unknown speed harness')
      const since = opts.since ? Date.parse(opts.since) : -Infinity
      if (opts.since && !Number.isFinite(since)) throw new Error('Invalid --since date')
      const selected = (s: SpeedSample) => (!opts.harness || s.harness === opts.harness) && Date.parse(s.startedAt) >= since
      const stored = await readSpeedSamples(opts.file, opts.limit, selected)
      const history = opts.history ? await readSpeedHistory(opts.historyLimit) : { samples: [], warnings: [] }
      const samples = [...stored.samples, ...history.samples.filter(selected)]
      const grouped = buildSpeedReport(samples)
      const report = { ...grouped, unavailableHarnesses: grouped.unavailableHarnesses.filter(h => !opts.harness || h === opts.harness),
        rejectedRecords: stored.rejected, omittedRecords: stored.omitted, warnings: history.warnings }
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderSpeedReport(report))
      if (!opts.json) {
        if (stored.rejected) process.stderr.write(`Ignored ${stored.rejected} invalid speed records\n`)
        if (stored.omitted) process.stderr.write(`Report uses a bounded recent window; ${stored.omitted} earlier matching records omitted\n`)
        for (const warning of history.warnings) process.stderr.write(warning + '\n')
      }
    })
  speed.command('events <request-id>').description('Inspect emission timestamps; token contents are never retained')
    .option('--file <path>', 'Speed telemetry JSONL file')
    .option('--harness <id>', 'Disambiguate a native request id')
    .action(async (id: string, opts) => {
      const harness = opts.harness ?? speed.opts().harness
      const { samples } = await readSpeedSamples(opts.file ?? speed.opts().file, 10_000, s => s.id === id && (!harness || s.harness === harness))
      const matches = samples.filter(s => s.id === id && (!harness || s.harness === harness))
      if (matches.length !== 1) throw new Error(matches.length ? 'Request id is ambiguous; specify --harness' : 'Speed request not found')
      console.log(JSON.stringify(matches[0], null, 2))
    })
  const serve = async (opts: { port: number; file: string; harness?: string; upstream?: string }) => {
    if (opts.harness && !isSpeedHarness(opts.harness)) throw new Error('Unknown speed harness')
    const active = await startSpeedServer({ ...opts, file: opts.file ?? speed.opts().file, harness: opts.harness as Parameters<typeof startSpeedServer>[0]['harness'],
      onSaveError: () => process.stderr.write('Speed telemetry could not be saved\n') })
    console.log(`CodeBurn speed ${opts.upstream ? 'proxy' : 'collector'}: ${active.url}`)
    console.log('Local timings only. No prompt/response content or credentials are saved. Ctrl-C to stop.')
    await new Promise<void>(resolve => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void active.close().finally(resolve) }
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
    })
  }
  speed.command('collect').description('Accept native timing samples on loopback POST /v1/speed')
    .option('--port <port>', 'Loopback port (0 chooses a free port)', port, 4319)
    .option('--file <path>', 'Local speed telemetry JSONL file').action(serve)
  speed.command('proxy').description('Observe OpenAI/Anthropic SSE without changing response bytes; records chunk arrival times')
    .requiredOption('--harness <id>', `Harness attribution (${SPEED_HARNESSES.join(', ')})`)
    .requiredOption('--upstream <origin>', 'HTTPS API origin, or a loopback HTTP origin')
    .option('--port <port>', 'Loopback port (0 chooses a free port)', port, 4319)
    .option('--file <path>', 'Local speed telemetry JSONL file').action(serve)
}
