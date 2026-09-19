// Extract the top-level production package names from `npm ls --parseable`
// output without anchoring on the checkout's absolute path.
//
// npm redacts UUID-shaped path segments to `***` in that output, so on a
// checkout whose path contains a UUID (CI runners, scratch worktrees) any
// absolute-prefix match finds nothing and staging reports an empty dependency
// closure (#1466). `npm ls` runs with its working directory at the package
// root, so every line it prints belongs to this project's tree however the
// prefix was mangled. The root's own node_modules is identified by POSITION —
// at however many `/node_modules` segments the real root path contains, the
// top-level name sits right after — and the redaction renames segments but
// cannot move one.

/** The set of top-level package names (`name` or `@scope/name`) named by the
 *  parseable lines, deduped. Nested transitive paths map to their top-level
 *  ancestor, mirroring the layout the stage copies into build/cli/node_modules.
 *  `rootModulesPath` is the real (unredacted) `<root>/node_modules` path; only
 *  the COUNT of its `/node_modules` segments is read, never its text, so a
 *  redacted line resolves by position alone. */
export function topLevelPackagesFromNpmLs(listed, rootModulesPath) {
  // `npm ls --parseable` prints native separators on Windows; normalize both
  // sides before segmenting so Store builds read the same tree.
  const depth = rootModulesPath.replaceAll('\\', '/').split('/node_modules').length - 1
  const names = new Set()
  for (const raw of listed.split('\n')) {
    const segments = raw.trim().replaceAll('\\', '/').split('/node_modules/')
    if (segments.length <= depth) continue
    const match = segments[depth].match(/^(@[^/]+\/[^/]+|[^/]+)/)
    if (!match) continue
    // A truncated tail can leave a bare scope (`@ns`) with no package after
    // it; that is not a package name, and join() below would copy the whole
    // scope directory.
    if (match[1].startsWith('@') && !match[1].includes('/')) continue
    names.add(match[1])
  }
  return names
}
