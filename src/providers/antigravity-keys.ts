/// Antigravity RPC dedup-key shapes, shared by the provider and the generic
/// dedup primitive without pulling the whole provider module (with its heavy
/// native deps) into the session-cache import graph.

/// Bare conversation key for an RPC-form dedup key (`antigravity:{cid}:...`
/// yields `antigravity:{cid}`), else null. Statusline and other shapes never
/// match: only the RPC form feeds the conversation prefix check.
export function rpcConversationBareKey(key: string): string | null {
  const parts = key.split(':')
  if (parts.length < 3 || parts[0] !== 'antigravity' || !parts[1]) return null
  return `antigravity:${parts[1]}`
}
