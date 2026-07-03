export type ActionKind =
  | 'mcp-remove' | 'mcp-project-scope'
  | 'archive-skill' | 'archive-agent' | 'archive-command'
  | 'claude-md-rule' | 'shell-config'
  | 'guard-install' | 'guard-uninstall'
  | 'model-default'

export type FileChange = {
  path: string            // absolute path modified
  backup: string | null   // backups/<id>/<n>.bak relative to the actions dir, null if the file did not exist before
  op: 'edit' | 'create' | 'move'
  movedTo?: string        // for op: 'move' (archives)
  afterHash: string       // sha256 of the post-apply bytes, checked for drift on undo
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
  baseline?: Record<string, number>
}

export type PlannedChange =
  | { op: 'edit'; path: string; content: string | Buffer }
  | { op: 'create'; path: string; content: string | Buffer }
  | { op: 'move'; path: string; movedTo: string }

export type ActionPlan = {
  kind: ActionKind
  description: string
  findingId?: string | null
  changes: PlannedChange[]
  baseline?: Record<string, number>
}
