import { isInteractiveScanUI, type ProjectFilterTarget, unmatchedRootedPatterns } from './parser.js'

/// A rooted --project/--exclude selects one project or nothing, so a typo does
/// not fail: it reports a total over a set nobody asked for, which reads like a
/// correct answer. Called once per command, by the command itself, over every
/// project identity that command could have matched.
///
/// Two callers must never see it. An Ink screen owns the terminal, so the same
/// `setInteractiveScanUI` latch the parser checks before printing scan progress
/// gates this too. And `serve` routes process.stderr.write into the progress-
/// frame emitter (runCaptured), so a warning would reach the desktop app as scan
/// progress: runStdioServe calls suppressProjectFilterWarnings() rather than
/// this module reading argv, which `codeburn --verbose serve` would shift.
let suppressed = false

export function suppressProjectFilterWarnings(): void {
  suppressed = true
}

export async function reportUnmatchedProjectPatterns(
  projects: readonly ProjectFilterTarget[],
  include?: readonly string[],
  exclude?: readonly string[],
  alsoKnown?: () => Promise<readonly ProjectFilterTarget[]>,
): Promise<void> {
  if (suppressed || isInteractiveScanUI()) return
  const patterns = [...(include ?? []), ...(exclude ?? [])]
  if (patterns.length === 0) return
  let unmatched = unmatchedRootedPatterns(projects, patterns)
  // Only then, and only for what is still missing: a command whose population is
  // the live parse alone would call a path wrong while the day cache bills it.
  if (unmatched.length > 0 && alsoKnown) {
    unmatched = unmatchedRootedPatterns(await alsoKnown(), unmatched)
  }
  for (const pattern of unmatched) {
    process.stderr.write(`codeburn: no project in this period matches ${pattern} (an absolute path has to be a project's path, or a prefix of it on a segment boundary)\n`)
  }
}
