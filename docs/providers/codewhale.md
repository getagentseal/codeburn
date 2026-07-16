# CodeWhale

CodeWhale CLI saved sessions.

- **Source:** `src/providers/codewhale.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/codewhale.test.ts`

## Where it reads from

| Source | Path |
|---|---|
| Current CodeWhale sessions | `~/.codewhale/sessions/*.json` |
| Legacy sessions not yet migrated | `~/.deepseek/sessions/*.json` |
| Explicit home | `$CODEWHALE_HOME/sessions/*.json` |

`CODEWHALE_HOME` is an exact CodeWhale home override. CodeBurn appends only
`sessions`; it does not append `.codewhale` and does not scan ambient legacy
state while the override is set.

Without an override, the current directory is scanned before the legacy one.
If both contain the same metadata session id, the current CodeWhale copy wins.
Discovery is read-only and never performs CodeWhale's own migration.

## Storage format

One JSON object per saved session:

```text
{
  "metadata": {
    "id": "...",
    "created_at": "...",
    "updated_at": "...",
    "total_tokens": 12345,
    "model": "...",
    "model_provider": "...",
    "workspace": "/path/to/project",
    "cost": {
      "session_cost_usd": 0.75,
      "subagent_cost_usd": 0.20
    }
  },
  "messages": [ ... ]
}
```

Like CodeWhale's own session picker, discovery first extracts the top-level
metadata object from a 64 KiB prefix. Full session JSON is read only when the
provider parses a discovered session (or metadata has an unusual layout). If a
transcript exceeds CodeBurn's full-file safety cap, authoritative aggregate
tokens and cost are still emitted from the prefix; only message/tool details
are omitted.

## Accounting

CodeWhale persists cumulative accounting at session level, not per LLM call,
so CodeBurn emits one record per saved session at `metadata.updated_at` (then
`created_at`, then file mtime as fallbacks).

- `metadata.total_tokens` is the only token counter. CodeWhale does not persist
  a reliable input/output/cache/reasoning split. CodeBurn puts the full value
  in the input column so the total remains exact and leaves the other token
  columns at zero rather than estimating a split.
- Exact stored USD cost is
  `session_cost_usd + subagent_cost_usd`, matching CodeWhale's `total_usd()`.
- When the cost snapshot is absent, CodeBurn prices the aggregate token total
  as input using the normal model table and treats the result as estimated.
- A stored zero-dollar snapshot remains authoritative; it is not replaced by
  an estimate.

## Tools and projects

The first user text block becomes the session prompt. Assistant `tool_use` and
`server_tool_use` blocks populate tool and tool-sequence data. Native names are
normalized to CodeBurn's standard set, including:

- `exec_shell*` / `task_shell*` -> `Bash`
- `read_file` -> `Read`
- `write_file` -> `Write`
- `edit_file` / `apply_patch` / `fim_edit` -> `Edit`
- `list_dir` -> `Glob`
- `grep_files` -> `Grep`
- `agent` / `agents/*` -> `Agent`
- `load_skill` -> `Skill`

Shell commands, edited/read file paths, skill names, and subagent types are
retained when present. `metadata.workspace` supplies both project grouping and
worktree canonicalization.

## Caching and deduplication

The shared session cache fingerprints each JSON file and includes
`CODEWHALE_HOME` in its environment fingerprint. CodeWhale-reported cost is
stored in the cached call so a warm scan does not replace it with model-table
pricing. Daily-cache version 11 forces a one-time historical re-hydration for
users upgrading from a version that did not discover CodeWhale.

Discovery deduplicates current and legacy files by metadata session id. The
parser key is `codewhale:<session-id>`.

## When fixing a bug here

1. Reproduce with a minimal real-shape saved-session JSON fixture.
2. Verify aggregate tokens and parent-plus-subagent cost before checking UI
   totals; do not infer an input/output split CodeWhale does not store.
3. Run `npm test -- tests/providers/codewhale.test.ts --run` and
   `npm test -- tests/provider-registry.test.ts tests/session-cache.test.ts --run`.
