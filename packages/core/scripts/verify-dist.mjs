#!/usr/bin/env node
// Refuses to let a half-built dist reach npm.
//
// `npm run build` is `tsup && tsc`. tsup runs with clean:true, so it wipes dist
// and writes JavaScript; if tsc then fails, dist holds .js with no declarations.
// The build exits non-zero, but nothing rebuilds at publish time, so a later
// `npm publish` would ship a package whose every `types` target 404s. Verified:
// removing the declarations and running `npm pack --dry-run` succeeds with
// 41/41 exports subpaths pointing at files that are not in the tarball.
//
// This script is the assertion that closes that gap. It runs from
// `prepublishOnly` (after the build) and in CI, so it is exercised on every
// push rather than only on the rare publish.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

const problems = []
let checked = 0

for (const [subpath, rawEntry] of Object.entries(pkg.exports ?? {})) {
  // A plain string target (e.g. "./schemas/*": "./schemas/*") applies to every
  // condition; normalize it so the import/types checks below stay uniform.
  const entry = typeof rawEntry === 'string' ? { import: rawEntry, types: rawEntry } : rawEntry
  for (const condition of ['import', 'types']) {
    const pattern = entry?.[condition]
    if (!pattern) {
      problems.push(`exports["${subpath}"] declares no "${condition}" target`)
      continue
    }
    checked++
    if (!pattern.includes('*')) {
      if (!existsSync(join(pkgRoot, pattern))) {
        problems.push(`exports["${subpath}"].${condition} -> ${pattern} does not exist`)
      }
      continue
    }
    // Subpath pattern: every file it can reach on disk must exist, or some
    // consumer resolves the export to nothing. Node's `*` spans "/" and does
    // not special-case dotfiles, so the walk is recursive and does not skip
    // dots — a shallower scan would let a nested tree (e.g. schemas/v2/) or a
    // dotfile pass the validator while remaining reachable through the export.
    const star = pattern.indexOf('*')
    const literal = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    // A literal prefix with no "/" at all (e.g. "foo*") means the scan starts
    // at the package root. lastIndexOf('/') would return -1 here, and
    // slice(0, -1) on it would truncate the name into a bogus directory, so
    // the "does not exist" report below would point at the wrong place.
    const slash = literal.lastIndexOf('/')
    const dir = slash === -1 ? pkgRoot : join(pkgRoot, literal.slice(0, slash))
    if (!existsSync(dir)) {
      problems.push(`exports["${subpath}"].${condition} -> ${pattern} directory does not exist`)
      continue
    }
    const reachable = []
    const walk = (d) => {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, name.name)
        if (name.isDirectory()) walk(full)
        else {
          const rel = './' + relative(pkgRoot, full)
          if (rel.startsWith(literal) && rel.endsWith(suffix)) reachable.push(rel)
        }
      }
    }
    walk(dir)
    if (reachable.length === 0) {
      problems.push(`exports["${subpath}"].${condition} -> ${pattern} matches no files`)
    }
  }
}

// `files` decides what actually ships; a target outside it is unreachable to a
// consumer even when it exists on disk here.
const shipped = pkg.files ?? []
if (!shipped.includes('dist')) {
  problems.push('package.json#files does not include "dist", so no export target would ship')
}

if (problems.length > 0) {
  console.error(`dist verification failed (${problems.length} problem(s)):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nRun `npm run build --workspace=@codeburn/core` and re-check.')
  process.exit(1)
}

console.log(
  `dist verified: ${checked} export targets across ${Object.keys(pkg.exports ?? {}).length} subpaths all present`,
)
