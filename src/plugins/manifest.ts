/// Plugin manifest schema for the codeburn plugin socket (teams issue #3,
/// phase-1 mechanism). One extension point lives in the CLI; every surface
/// consumes CLI output, so a plugin extends all of them through here.
///
/// The manifest is a security contract, not metadata: a plugin may only add
/// what it declares, and the CLI's disclosure renderings are generated from
/// these declarations. Unknown fields are REJECTED (strict) so a plugin can
/// smuggle no capability through a field the loader forgot to read.

import { z } from 'zod'

/// Lower-case dotted key: `teams.section`, `ai.task_category`, ...
const DOTTED_KEY = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/

const SUBCOMMAND = /^[a-z][a-z0-9-]{0,31}$/

export const pluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'plugin name: lower-case, digits, dashes'),
  version: z.string().min(1).max(32),
  /// Space-separated comparators over the CLI version, e.g. ">=0.9.22 <0.11".
  cliCompat: z.string().min(1).max(128),
  capabilities: z.object({
    commands: z.array(z.string().regex(SUBCOMMAND)).max(16).default([]),
    /// Extra wire fields. A plugin attribute that is not declared here never
    /// reaches the wire (enforced in sync/otlp.ts, not merely discouraged).
    syncAttributes: z.array(z.object({
      key: z.string().regex(DOTTED_KEY).max(128),
      /// Shown to members in `sync push --dry-run`. The disclosure is the
      /// gate: an attribute without one is refused at parse time.
      disclosure: z.string().min(10).max(500),
    }).strict()).max(64).default([]),
    payloadSections: z.array(z.string().regex(SUBCOMMAND)).max(16).default([]),
    spanKinds: z.array(z.string().regex(DOTTED_KEY).max(128)).max(16).default([]),
  }).strict().prefault({}),
}).strict()

export type PluginManifest = z.infer<typeof pluginManifestSchema>

export type ParseResult = { ok: true, manifest: PluginManifest } | { ok: false, reason: string }

export function parsePluginManifest(raw: unknown, source: string): ParseResult {
  const parsed = pluginManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, reason: `${source}: ${first?.path.join('.') || '(root)'}: ${first?.message ?? 'invalid manifest'}` }
  }
  return { ok: true, manifest: parsed.data }
}

/// Minimal semver-ish compare: dot-separated numeric segments, missing = 0.
/// Enough for the ">=x.y.z <a.b.c" ranges manifests declare; no dependency.
/// Note: prerelease suffixes compare as extra numeric segments, so "1.0.0-canary" > "1.0.0".
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0)
  const pb = b.split('.').map(s => parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/// Returns null when the CLI version satisfies the range, otherwise the
/// offending comparator (so the CLI can print a polite refusal).
export function checkCliCompat(cliCompat: string, cliVersion: string): string | null {
  for (const term of cliCompat.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/.exec(term)
    if (!m) return `unparseable range term "${term}"`
    const cmp = compareVersions(cliVersion, m[2]!)
    const ok = m[1] === '>=' ? cmp >= 0
      : m[1] === '<=' ? cmp <= 0
      : m[1] === '>' ? cmp > 0
      : m[1] === '<' ? cmp < 0
      : cmp === 0
    if (!ok) return `requires codeburn ${term}`
  }
  return null
}
