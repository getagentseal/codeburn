import { execFileSync } from 'node:child_process'
import { delimiter, isAbsolute, join } from 'node:path'

import { nodeManagerDirs } from '../../app/electron/cli'

/** What runs the bundled CLI. */
export type Runtime =
  | { kind: 'host'; version: string }
  | { kind: 'node'; bin: string; version: string }
  /** The editor's own Node, which lacks node:sqlite or is older than the CLI's floor. */
  | { kind: 'degraded'; version: string; sqlite: boolean }

export type NodeProbe = { version: string; sqlite: boolean }

const FLOOR: [number, number] = [22, 13]

export function meetsFloor(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > FLOOR[0] || (major === FLOOR[0] && minor >= FLOOR[1])
}

/**
 * Prefer the editor's own Node (no second runtime to find) when it is new enough
 * and has node:sqlite, which the Cursor, OpenCode and Copilot readers need. Else
 * a configured or discovered Node that is. Else the editor's Node, degraded.
 */
export function chooseRuntime(opts: {
  host: NodeProbe
  configured: string
  candidates: string[]
  probe: (bin: string) => NodeProbe | null
}): Runtime {
  const usable = (probe: NodeProbe | null): boolean => probe !== null && meetsFloor(probe.version) && probe.sqlite
  if (opts.configured && isAbsolute(opts.configured)) {
    const probe = opts.probe(opts.configured)
    if (probe && usable(probe)) return { kind: 'node', bin: opts.configured, version: probe.version }
  }
  if (usable(opts.host)) return { kind: 'host', version: opts.host.version }
  for (const bin of opts.candidates) {
    const probe = opts.probe(bin)
    if (probe && usable(probe)) return { kind: 'node', bin, version: probe.version }
  }
  return { kind: 'degraded', version: opts.host.version, sqlite: opts.host.sqlite }
}

export function hostProbe(): NodeProbe {
  let sqlite = false
  try {
    require('node:sqlite')
    sqlite = true
  } catch { /* absent before Node 22.5 */ }
  return { version: process.versions.node, sqlite }
}

export function probeNode(bin: string): NodeProbe | null {
  try {
    const out = execFileSync(bin, ['-e', "let s=0;try{require('node:sqlite');s=1}catch{};process.stdout.write(process.versions.node+' '+s)"], {
      encoding: 'utf-8', timeout: 5_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
    })
    const [version, sqlite] = out.trim().split(' ')
    return version ? { version, sqlite: sqlite === '1' } : null
  } catch {
    return null
  }
}

/** Every `node` on PATH plus the usual version-manager homes, in that order. */
export function nodeCandidates(): string[] {
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...nodeManagerDirs()]
  if (process.platform === 'win32' && process.env.ProgramFiles) dirs.push(join(process.env.ProgramFiles, 'nodejs'))
  return [...new Set(dirs.filter(dir => isAbsolute(dir)).map(dir => join(dir, name)))]
}
