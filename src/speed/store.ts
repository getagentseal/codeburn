import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { getCodeburnCacheDir } from '../cache-dir.js'
import { validateSpeedSample, type SpeedSample } from './types.js'

export function speedFile(): string {
  return process.env.CODEBURN_SPEED_FILE || join(getCodeburnCacheDir(), 'speed.jsonl')
}

async function rejectLink(file: string): Promise<void> {
  const info = await lstat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
  if (info && !info.isFile()) throw new Error('Speed store must be a regular file, not a link')
}

export async function appendSpeedSample(sample: SpeedSample, file = speedFile()): Promise<void> {
  const record = validateSpeedSample(sample)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await rejectLink(file)
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Speed store must be a regular file')
    await handle.chmod(0o600)
    // One append per request, including its timeline, avoids interleaved events
    // from parallel calls. No prompt/response payload is stored.
    const bytes = Buffer.from(JSON.stringify(record) + '\n')
    const result = await handle.write(bytes)
    if (result.bytesWritten !== bytes.length) throw new Error('Incomplete speed record write')
  } finally { await handle.close() }
}

export async function readSpeedSamples(file = speedFile(), limit = 10_000, matches: (sample: SpeedSample) => boolean = () => true): Promise<{ samples: SpeedSample[]; rejected: number; omitted: number }> {
  let handle
  try { await rejectLink(file); handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { samples: [], rejected: 0, omitted: 0 }
    throw err
  }
  const samples = new Map<string, { sample: SpeedSample; weight: number }>()
  // A count cap alone allows a billion token-event objects (10k x 100k).
  // Keep a bounded recent window; the complete timelines remain on disk.
  const memoryBudget = 64 * 1024 * 1024
  let rejected = 0, omitted = 0, retained = 0
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Speed store must be a regular file')
    const lines = createInterface({ input: handle.createReadStream({ autoClose: false }), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error('Oversized sample')
        const sample = validateSpeedSample(JSON.parse(line))
        if (!matches(sample)) continue
        const key = JSON.stringify([sample.harness, sample.source, sample.id])
        const weight = 1024 + sample.events.length * 80
        retained -= samples.get(key)?.weight ?? 0
        samples.delete(key)
        samples.set(key, { sample, weight }); retained += weight
        while (samples.size > limit || retained > memoryBudget) {
          const oldest = samples.keys().next().value!
          retained -= samples.get(oldest)!.weight
          samples.delete(oldest); omitted++
        }
      } catch { rejected++ }
    }
  } finally { await handle.close() }
  return { samples: [...samples.values()].map(v => v.sample), rejected, omitted }
}
