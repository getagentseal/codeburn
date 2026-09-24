import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Resolve CodeBurn's shared cache directory at call time.
 *
 * Reading the environment on every call matters for embedded consumers and
 * tests that change CODEBURN_CACHE_DIR after importing the CLI modules.
 */
export function getCodeburnCacheDir(): string {
  const override = process.env['CODEBURN_CACHE_DIR']
  return override?.trim() ? override : join(homedir(), '.cache', 'codeburn')
}

/** Providers CodeBurn no longer reads. Their session cache sections and daily
 *  history slices are dropped on load, so a removed tool leaves nothing behind. */
export const RETIRED_PROVIDER_NAMES: ReadonlySet<string> = new Set(['roo-code'])

/** A versioned cache file is the only source when it exists. Legacy adoption is ENOENT-only. */
export type ExistingTextFile =
  | { status: 'absent' }
  | { status: 'unreadable' }
  | { status: 'ok'; text: string }

export async function readExistingTextFile(path: string): Promise<ExistingTextFile> {
  try {
    return { status: 'ok', text: await readFile(path, 'utf-8') }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined
    return { status: code === 'ENOENT' ? 'absent' : 'unreadable' }
  }
}
