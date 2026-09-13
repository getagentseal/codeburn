/**
 * Deterministic local work-unit resolver (CB-2, slice 1 of the CodeBurn
 * main/Teams boundary spec). Groups parsed sessions carrying the #1140
 * provider-recorded `lineage` field into work units: one observed root session
 * plus its directly evidenced delegated children.
 *
 * Rules (spec sections 1 and 3, MAIN-01/MAIN-02):
 * - Only provider-recorded lineage is honored. A session without lineage is its
 *   own standalone unit (role `unknown`, never guessed).
 * - One-sided evidence folds: a child that names an in-range parent folds under
 *   it even when the parent recorded nothing itself.
 * - Fail closed: a parent id that matches no session in range leaves the child
 *   ungrouped for that view; a cycle or self-reference is broken and every
 *   participant is marked `unknown`; a duplicate (provider, id) pair is
 *   ambiguous and never folds either way.
 * - No inference from time adjacency, shared projects, or directory layout.
 * - Deterministic: the same input set yields byte-identical output regardless
 *   of input order.
 *
 * No wire/sync changes and no daily-cache changes live here.
 */

import { deriveTraceId } from './sync/otlp.js'
import type { SessionLineage } from './types.js'

export type WorkUnitRole = 'root' | 'child' | 'unknown'

/// Minimal session shape the resolver needs. `provider` scopes the lineage
/// linkage so a cross-provider session-id collision can never fold (MAIN-02).
export type WorkUnitSession = {
  sessionId: string
  provider: string
  lineage?: SessionLineage
}

export type WorkUnitMember = {
  sessionId: string
  /// The member's provider. Within one unit every member shares the root's
  /// provider: a lineage edge is only ever resolved against a parent with the
  /// same provider key, so cross-provider id collisions can never join.
  provider: string
  role: WorkUnitRole
}

export type WorkUnit = {
  /// deriveTraceId(rootSessionId): the exact trace-id derivation sync uses, so
  /// a work unit's identity matches the root trace identity already on the wire.
  workUnitId: string
  rootSessionId: string
  /// The root record's provider. Present even on ambiguous-duplicate units
  /// (which carry no bySession mapping): the record itself knew its provider.
  rootProvider: string
  /// Sorted member children (transitive descendants fold under the top root).
  childSessionIds: string[]
  /// Role per member session id, root included. Standalone units carry their
  /// single member as `unknown` unless the provider recorded it as a root.
  /// Keys are session ids only — safe because all members share one provider.
  roles: Record<string, WorkUnitRole>
  /// Provider-scoped membership in presentation order: root first, then the
  /// children of `childSessionIds`. Additive twin of childSessionIds+roles that
  /// lets JSON consumers join members back to session rows without guessing a
  /// provider for a bare id.
  members: WorkUnitMember[]
}

export type WorkUnitResolution = {
  /// Every input session belongs to exactly one unit. Sorted by workUnitId.
  units: WorkUnit[]
  /// workUnitSessionKey(provider, sessionId) -> workUnitId, for presentation.
  /// Ambiguous duplicate (provider, id) records are deliberately absent.
  bySession: Map<string, string>
}

// NUL delimiter: it cannot appear in a provider name or session id, so keys
// never collide (mirrors the by-PR linkage keying in sessions-report.ts).
const KEY_SEP = String.fromCharCode(0)

export function workUnitSessionKey(provider: string, sessionId: string): string {
  return `${provider}${KEY_SEP}${sessionId}`
}

/// A session is a child edge only when the provider durably recorded both the
/// child role and the parent id. Any other shape (root, missing parent id, a
/// future non-`provider-recorded` evidence class) contributes no edge.
function isRecordedChild(session: WorkUnitSession): boolean {
  return session.lineage?.evidence === 'provider-recorded'
    && session.lineage.role === 'child'
    && typeof session.lineage.parentSessionId === 'string'
    && session.lineage.parentSessionId.length > 0
}

export function resolveWorkUnits(sessions: WorkUnitSession[]): WorkUnitResolution {
  // Canonical processing order: provider+id, then lineage content as a
  // tie-break so duplicate-id records order identically under any input order.
  const sorted = [...sessions].sort((a, b) =>
    workUnitSessionKey(a.provider, a.sessionId).localeCompare(workUnitSessionKey(b.provider, b.sessionId))
    || JSON.stringify(a.lineage ?? null).localeCompare(JSON.stringify(b.lineage ?? null)))

  const byKey = new Map<string, WorkUnitSession>()
  const ambiguous = new Set<string>()
  for (const session of sorted) {
    const key = workUnitSessionKey(session.provider, session.sessionId)
    if (byKey.has(key)) ambiguous.add(key)
    else byKey.set(key, session)
  }

  // Walk a child's parent chain to the topmost in-range ancestor. Returns null
  // (fail closed) on a missing or ambiguous parent link, a cycle, or a
  // self-reference; the child then stays ungrouped for this view.
  const resolveRoot = (start: WorkUnitSession): string | null => {
    const visited = new Set<string>()
    let current = start
    while (isRecordedChild(current)) {
      const currentKey = workUnitSessionKey(current.provider, current.sessionId)
      if (visited.has(currentKey)) return null
      visited.add(currentKey)
      const parentKey = workUnitSessionKey(current.provider, current.lineage!.parentSessionId!)
      if (ambiguous.has(parentKey)) return null
      const parent = byKey.get(parentKey)
      if (!parent) return null
      current = parent
    }
    return workUnitSessionKey(current.provider, current.sessionId)
  }

  // Children fold under their resolved root, keyed by the root's session key.
  // A record with an ambiguous (provider, id) key never folds and never roots
  // a fold: two conflicting records share the id, so neither can be trusted.
  const childrenByRootKey = new Map<string, WorkUnitSession[]>()
  const foldedRecords = new Set<WorkUnitSession>()
  for (const session of sorted) {
    const key = workUnitSessionKey(session.provider, session.sessionId)
    if (ambiguous.has(key) || !isRecordedChild(session)) continue
    const rootKey = resolveRoot(session)
    if (!rootKey || rootKey === key) continue
    const list = childrenByRootKey.get(rootKey)
    if (list) list.push(session)
    else childrenByRootKey.set(rootKey, [session])
    foldedRecords.add(session)
  }

  const units: WorkUnit[] = []
  const bySession = new Map<string, string>()
  for (const session of sorted) {
    if (foldedRecords.has(session)) continue // emitted with its root's unit
    const key = workUnitSessionKey(session.provider, session.sessionId)
    const children = (childrenByRootKey.get(key) ?? [])
      .map(child => child.sessionId)
      .sort()
    const role: WorkUnitRole =
      children.length > 0 ? 'root'
      : session.lineage?.evidence === 'provider-recorded' && session.lineage.role === 'root' ? 'root'
      : 'unknown'
    const roles: Record<string, WorkUnitRole> = { [session.sessionId]: role }
    for (const childId of children) roles[childId] = 'child'
    const unit: WorkUnit = {
      workUnitId: deriveTraceId(session.sessionId),
      rootSessionId: session.sessionId,
      rootProvider: session.provider,
      childSessionIds: children,
      roles,
      members: [
        { sessionId: session.sessionId, provider: session.provider, role },
        ...children.map(childId => ({ sessionId: childId, provider: session.provider, role: 'child' as const })),
      ],
    }
    units.push(unit)
    // Ambiguous duplicate records share one key; registering it would point
    // both records at one arbitrary unit, so presentation leaves them alone.
    if (!ambiguous.has(key)) {
      bySession.set(key, unit.workUnitId)
      for (const child of childrenByRootKey.get(key) ?? []) {
        bySession.set(workUnitSessionKey(child.provider, child.sessionId), unit.workUnitId)
      }
    }
  }

  units.sort((a, b) => a.workUnitId.localeCompare(b.workUnitId))
  return { units, bySession }
}
