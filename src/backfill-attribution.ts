/**
 * Backfill session attribution for workspace sessions.
 *
 * Scans all JSONL session files in the workspace directory, extracts file
 * paths from tool_use blocks and CWD fields, and determines the dominant
 * project for each session. Writes results to session-projects.jsonl.
 *
 * Usage:
 *   npx tsx src/backfill-attribution.ts [--dry-run]
 *
 * Or after build:
 *   node dist/backfill-attribution.js [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

const PROJECTS_BASE = join(homedir(), '.claude', 'projects')
const CONFIG_DIR = process.env['CODEBURN_CONFIG_DIR'] || join(homedir(), '.config', 'codeburn')
const OUTPUT_PATH = join(CONFIG_DIR, 'session-projects.jsonl')
const DRY_RUN = process.argv.includes('--dry-run')

/** System path segments to skip when identifying projects. */
const SYSTEM_SEGS = new Set([
  'users', 'user', 'home', 'projects', 'documents', 'desktop',
  'volumes', 'mnt', 'opt', 'var', 'tmp',
])

/** Generic subdirectory names — too ambiguous to be project names. */
const GENERIC_DIRS = new Set([
  'src', 'dist', 'docs', 'scripts', 'tests', 'test', 'lib',
  'public', 'assets', 'templates', 'web', 'app', 'frontend',
  'backend', 'config', 'data', 'build', 'out', 'node_modules',
])

function extractProjectFromFilePath(filepath: string): string | null {
  // Find "/projects/" in the path and take the segment after it
  const marker = '/projects/'
  const idx = filepath.indexOf(marker)
  if (idx < 0) return null
  const remainder = filepath.slice(idx + marker.length)
  const top = remainder.split('/')[0]
  if (!top || GENERIC_DIRS.has(top.toLowerCase())) return null
  return top
}

interface ProjectHits {
  [project: string]: number
}

function scanSession(filepath: string): { project: string | null; date: string } {
  const hits: ProjectHits = {}
  let date = ''

  const content = readFileSync(filepath, { encoding: 'utf-8' })
  for (const line of content.split('\n')) {
    if (!line.trim()) continue

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    // Extract date
    if (!date) {
      const ts = obj['timestamp'] as string | undefined
      if (ts && ts.length >= 10) date = ts.slice(0, 10)
    }

    // Signal 1: CWD field
    const cwd = obj['cwd'] as string | undefined
    if (cwd) {
      const proj = extractProjectFromFilePath(cwd + '/')
      if (proj) hits[proj] = (hits[proj] ?? 0) + 3
    }

    // Signal 2: tool_use blocks
    const msg = obj['message'] as Record<string, unknown> | undefined
    if (!msg) continue

    const content = msg['content']
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>

      if (b['type'] === 'tool_use') {
        const input = b['input'] as Record<string, unknown> | undefined
        if (!input) continue
        for (const key of ['file_path', 'path', 'command']) {
          const val = input[key]
          if (typeof val === 'string' && val.includes('/projects/')) {
            const proj = extractProjectFromFilePath(val)
            if (proj) {
              const weight = key === 'file_path' ? 2 : 1
              hits[proj] = (hits[proj] ?? 0) + weight
            }
          }
        }
      }
    }
  }

  // Find dominant project
  let best: string | null = null
  let bestCount = 0
  for (const [proj, count] of Object.entries(hits)) {
    if (count > bestCount) {
      best = proj
      bestCount = count
    }
  }

  // Require minimum signal strength
  if (bestCount < 3) return { project: null, date }
  return { project: best, date }
}

function findWorkspaceDirs(): string[] {
  // Find directories that encode paths ending in "projects" (workspace root)
  const result: string[] = []
  try {
    for (const entry of readdirSync(PROJECTS_BASE)) {
      const lower = entry.toLowerCase()
      if (lower.endsWith('-projects') || lower.endsWith('projects')) {
        const full = join(PROJECTS_BASE, entry)
        try {
          if (statSync(full).isDirectory()) result.push(full)
        } catch { continue }
      }
    }
  } catch { /* no projects dir */ }
  return result
}

function loadExisting(): Set<string> {
  const existing = new Set<string>()
  if (!existsSync(OUTPUT_PATH)) return existing
  const content = readFileSync(OUTPUT_PATH, 'utf-8')
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { session_id?: string }
      if (entry.session_id) existing.add(entry.session_id)
    } catch { continue }
  }
  return existing
}

function main() {
  const workspaceDirs = findWorkspaceDirs()
  if (workspaceDirs.length === 0) {
    console.log('No workspace session directories found.')
    return
  }

  const existing = loadExisting()
  console.log(`Found ${workspaceDirs.length} workspace director${workspaceDirs.length === 1 ? 'y' : 'ies'}`)
  console.log(`Already attributed: ${existing.size} sessions`)

  if (!DRY_RUN) mkdirSync(CONFIG_DIR, { recursive: true })

  let attributed = 0
  let skipped = 0
  let noSignal = 0
  const projectCounts: Record<string, number> = {}
  let totalFiles = 0

  for (const dir of workspaceDirs) {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))

    totalFiles += files.length
    console.log(`\nScanning ${files.length} sessions in ${basename(dir)}...`)

    for (let i = 0; i < files.length; i++) {
      const sessionId = basename(files[i]!, '.jsonl')
      if (existing.has(sessionId)) {
        skipped++
        continue
      }

      const { project, date } = scanSession(join(dir, files[i]!))
      if (project) {
        const entry = JSON.stringify({ session_id: sessionId, project, date })
        if (!DRY_RUN) {
          appendFileSync(OUTPUT_PATH, entry + '\n')
        }
        attributed++
        projectCounts[project] = (projectCounts[project] ?? 0) + 1
      } else {
        noSignal++
      }

      if ((i + 1) % 50 === 0) {
        process.stdout.write(`  ${i + 1}/${files.length}...\r`)
      }
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Results:`)
  console.log(`  Total sessions scanned: ${totalFiles}`)
  console.log(`  Attributed: ${attributed}`)
  console.log(`  Skipped (existing): ${skipped}`)
  console.log(`  No signal: ${noSignal}`)

  if (attributed > 0) {
    console.log('\nProject breakdown:')
    const sorted = Object.entries(projectCounts).sort((a, b) => b[1] - a[1])
    for (const [proj, count] of sorted) {
      console.log(`  ${proj.padEnd(30)} ${String(count).padStart(4)} sessions`)
    }
  }

  if (DRY_RUN) {
    console.log(`\nTo apply, run without --dry-run. Output: ${OUTPUT_PATH}`)
  } else if (attributed > 0) {
    console.log(`\nWritten to ${OUTPUT_PATH}`)
    console.log('Restart codeburn to see updated project attribution.')
  }
}

main()
