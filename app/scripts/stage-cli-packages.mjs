// Extract the top-level production package names from `npm ls --parseable`
// output without anchoring on the checkout's absolute path.
//
// npm 12 redacts UUID-shaped path segments to `***` in that output, so on a
// checkout whose path contains a UUID (CI runners, scratch worktrees) any
// absolute-prefix match finds nothing and staging reports an empty dependency
// closure (#1466). `npm ls` runs with its working directory at the package
// root, so every line it prints belongs to this project's tree however the
// prefix was mangled. The root's own node_modules is identified by POSITION —
// at however many `/node_modules` occurrences the real root path contains, the
// top-level name sits right after that occurrence — and the redaction cannot
// move an occurrence, only rename the segments around it.

function nodeModulesOccurrences(path, from) {
  const normalized = path.replaceAll('\\', '/')
  let count = 0
  let at = normalized.indexOf('/node_modules', from)
  while (at !== -1) {
    count += 1
    at = normalized.indexOf('/node_modules', at + 1)
  }
  return count
}

/** Index just past the `n`-th (1-based) `/node_modules` occurrence, or -1. */
function nthNodeModulesEnd(path, n) {
  const normalized = path.replaceAll('\\', '/')
  let seen = 0
  let at = normalized.indexOf('/node_modules')
  while (at !== -1) {
    seen += 1
    if (seen === n) return at + '/node_modules'.length
    at = normalized.indexOf('/node_modules', at + 1)
  }
  return -1
}

/** The set of top-level package names (`name` or `@scope/name`) named by the
 *  parseable lines, deduped. Nested transitive paths map to their top-level
 *  ancestor, mirroring the layout the stage copies into build/cli/node_modules.
 *  `rootModulesPath` is the real (unredacted) `<root>/node_modules` path; only
 *  the COUNT of its `/node_modules` occurrences is read, never its text, so a
 *  redacted line resolves by position alone. */
export function topLevelPackagesFromNpmLs(listed, rootModulesPath) {
  const depth = nodeModulesOccurrences(rootModulesPath, 0)
  const names = new Set()
  for (const raw of listed.split('\n')) {
    // `npm ls --parseable` prints native separators on Windows; normalize
    // before segmenting so Store builds read the same tree.
    const line = raw.trim().replaceAll('\\', '/')
    if (nodeModulesOccurrences(line, 0) < depth) continue
    const nameAt = nthNodeModulesEnd(line, depth)
    if (nameAt === -1) continue
    const rest = line.slice(nameAt).replace(/^\//, '')
    const match = rest.match(/^(@[^/]+\/[^/]+|[^/]+)/)
    if (!match) continue
    // A truncated tail can leave a bare scope (`@ns`) with no package after
    // it; that is not a package name, and join() below would copy the whole
    // scope directory.
    if (match[1].startsWith('@') && !match[1].includes('/')) continue
    names.add(match[1])
  }
  return names
}
