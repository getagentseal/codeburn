// The build stamp's dirty check, factored out so it is unit-testable.
//
// Packaging regenerates the pricing-snapshot files from a live feed
// (scripts/bundle-litellm.mjs) DURING the build, so an otherwise-clean release
// checkout shows those two tracked files as modified at stamp time. Treating that
// as "-dirty" is a false positive: the committed source is clean. The dirty flag
// must therefore ignore exactly these regenerated files.

/** Tracked files the packaging build rewrites from a live feed. Changes limited
 *  to these must NOT flip the build stamp to "-dirty". */
export const GENERATED_DATA_FILES = [
  'src/data/litellm-snapshot.json',
  'src/data/pricing-fallback.json',
]

/**
 * True when `git status --porcelain` reports any change OTHER than the
 * regenerated pricing snapshots. Porcelain lines are `XY <path>` (path from
 * column 3); a rename is `XY old -> new`, counted by its destination. Quoted
 * paths (special chars) are unquoted before comparison.
 */
export function isDirtyIgnoringGenerated(porcelain: string): boolean {
  const generated = new Set(GENERATED_DATA_FILES)
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    let path = line.slice(3).trim()
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    path = path.replace(/^"(.*)"$/, '$1')
    if (!generated.has(path)) return true
  }
  return false
}
