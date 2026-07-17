# OpenCode

OpenCode (sst/opencode).

- **Source:** `src/providers/opencode.ts`
- **Loading:** lazy (`src/providers/index.ts:59-75`)
- **Test:** `tests/providers/opencode.test.ts` (676 lines, the largest provider test)

## Where it reads from

Default `~/.local/share/opencode/` or `$XDG_DATA_HOME/opencode/`. The discovery walk picks up `opencode*.db` files (`opencode.ts:71-88`).

For renamed/forked OpenCode-compatible builds (e.g. MiMoCode writing
`~/.local/share/mimocode/mimicode.db` with the same `session`/`message`/`part`
schema), point CodeBurn at the fork's data directory with two env vars:

- `OPENCODE_DATA_DIR` — the **exact** data directory (no `opencode` suffix is
  appended). Example: `OPENCODE_DATA_DIR=$HOME/.local/share/mimocode`. Relocates
  both file-based and SQLite storage.
- `OPENCODE_DB_PREFIX` — the SQLite filename prefix (default `opencode`,
  matching `opencode*.db`). Example: `OPENCODE_DB_PREFIX=mimicode` discovers
  `mimicode*.db`. Affects SQLite discovery only; file-based storage under
  `<OPENCODE_DATA_DIR>/storage/` is found regardless.

Precedence when no `dataDir` argument is passed (the production path):
`OPENCODE_DATA_DIR` → `$XDG_DATA_HOME/opencode` → `~/.local/share/opencode`.

## Storage format

SQLite (older builds) or file-based JSON (OpenCode 1.1+, under `storage/`).

## Caching

None.

## Deduplication

Per `<sessionId>:<messageId>`.

## Quirks

- **Schema validation is loud.** When a required table is missing, the parser logs an actionable warning telling the user which table is gone and what version of OpenCode it expects. This is the right behavior; do not silently swallow these.
- Source paths are encoded as `<dbPath>:<sessionId>`.
- Discovery only emits root sessions (`parent_id IS NULL`) to avoid double
  counting. Parsing a root session walks the unarchived `session.parent_id`
  subtree, so child and grandchild agent sessions contribute their message,
  token, and tool usage back to the root session.
- Each message's `parts` are indexed; preserving the order matters for reasoning-token correctness.
- Tokens are reported across `input`, `output`, `reasoning`, `cache.read`, and `cache.write`. Anthropic semantics.
- Assistant messages with missing router usage are kept as zero-cost calls
  when their parts contain non-empty text or tool activity. Empty zero-usage
  assistant placeholders are still skipped.
- External MCP tools are stored as `<server>_<tool>` names (for example
  `clickup_clickup_get_task`). The provider normalizes those to CodeBurn's
  canonical `mcp__<server>__<tool>` names before aggregation so shared MCP
  panels and `optimize` findings count OpenCode usage.

## When fixing a bug here

1. The 558-line test suite catches a lot. Run `npm test -- tests/providers/opencode.test.ts` before and after any change.
2. If the bug is "missing table" warning, do not catch and silence it. Either upgrade the version expectation in the parser or document the breaking schema change.
3. If the bug is "reasoning tokens off by one", check the parts index ordering.
