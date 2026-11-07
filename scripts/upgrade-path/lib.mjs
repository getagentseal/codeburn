import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

export function copilotOtelDbPath(home, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const tail = ['Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db']
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', ...tail)
  if (platform === 'win32') return p.join(home, 'AppData', 'Roaming', ...tail)
  return p.join(home, '.config', ...tail)
}

export function assertInside(home, target, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const rel = p.relative(home, target)
  if (rel === '' || rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) throw new Error(`refusing to touch ${target}: outside corpus home ${home}`)
}

export function treeStats(dir) {
  const out = {}
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else out[path.relative(dir, f)] = createHash('sha1').update(readFileSync(f)).digest('hex')
    }
  }
  walk(dir)
  return out
}

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]).sort()
}

export function warmReparseProblems(workerLines, changed) {
  const problems = changed.map(f => `cache file changed on warm run: ${f}`)
  for (const l of workerLines) if (!/\b0 pending files\b|no full parses pending/.test(l)) problems.push(`re-parse work reported: ${l.trim()}`)
  return problems
}
