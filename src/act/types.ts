export type ActionKind =
  | 'mcp-remove' | 'mcp-project-scope'
  | 'defer-enable' | 'defer-alwaysload' | 'defer-threshold'
  | 'archive-skill' | 'archive-agent' | 'archive-command'
  | 'claude-md-rule' | 'shell-config'
  | 'guard-install' | 'guard-uninstall'
  | 'model-default'

export type FileChange = {
  path: string            // absolute path modified
  backup: string | null   // backups/<id>/<n>.bak relative to the actions dir, null if the file did not exist before
  op: 'edit' | 'create' | 'move'
  movedTo?: string        // for op: 'move' (archives)
  destBackup?: string | null  // move ops: snapshot of a file that already existed at movedTo
  afterHash: string       // sha256 of the post-apply bytes, checked for drift on undo
}

// Before/after measurement captured when an action is applied, diffed against
// the post-apply window by `act report`. `metrics` holds the kind-specific
// numbers:
//   mcp-remove / mcp-project-scope: server name -> schema tokens per session
//   archive-skill|agent|command:    item name   -> definition tokens per session
//   claude-md-rule (read/edit rule): { reads, edits }
//   shell-config (bash cap):         { calls }
//   guard-install:                   { abandonedPct, avgSessionCostUSD }
// estimatedTokens is the finding's estimate at apply time (0 for guard, which
// is a correlation signal, not a token estimate). sessions is the affected-scope
// session count over the window, kept out of `metrics` so it can never collide
// with a server literally named "sessions"; it feeds only the volume-shift
// confidence check.
export type ActionBaseline = {
  windowDays: number
  capturedAt: string
  estimatedTokens: number
  sessions: number
  metrics: Record<string, number>
  // model-default only: identifies the candidate independently of metrics key order.
  candidateModel?: string
}

export type ActionRecord = {
  id: string              // crypto.randomUUID()
  at: string              // ISO timestamp
  kind: ActionKind
  findingId: string | null
  description: string     // one human sentence, shown in `act list`
  changes: FileChange[]
  status: 'applied' | 'undone'
  undoneAt?: string
  baseline?: ActionBaseline
}

// expectedHash: sha256 of the raw on-disk bytes the plan's content was
// computed from (null when the plan expects the file to be absent). runAction
// refuses to apply when the target no longer matches, so a file edited
// between preview and confirm is never silently clobbered with stale
// content. undefined skips the check.
export type PlannedChange =
  | { op: 'edit'; path: string; content: string | Buffer; expectedHash?: string | null }
  | { op: 'create'; path: string; content: string | Buffer; expectedHash?: string | null }
  | { op: 'move'; path: string; movedTo: string }

export type ActionPlan = {
  kind: ActionKind
  description: string
  findingId?: string | null
  changes: PlannedChange[]
  baseline?: ActionBaseline
}
