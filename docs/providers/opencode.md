# OpenCode

OpenCode (sst/opencode).

- **Source:** `src/providers/opencode.ts`
- **Loading:** lazy (`src/providers/index.ts:59-75`)
- **Test:** `tests/providers/opencode.test.ts` (868 lines)

## Where it reads from

Default `~/.local/share/opencode/` or `$XDG_DATA_HOME/opencode/`. The discovery walk picks up `opencode*.db` files (`opencode.ts:99-108`).

## Storage format

SQLite.

## Caching

Uses the shared session cache keyed by the real SQLite database file path.

## Deduplication

Per `<sessionId>:<messageId>`.

## Quirks

- **Schema validation is loud.** When a required table is missing, the parser logs an actionable warning telling the user which table is gone and what version of OpenCode it expects. This is the right behavior; do not silently swallow these.
- Discovery emits one source per `opencode*.db` file so the shared cache can
  fingerprint the actual SQLite file. The parser then iterates unarchived root
  sessions (`parent_id IS NULL`) inside the database.
- Parsing a root session walks the unarchived `session.parent_id` subtree, so
  child and grandchild agent sessions contribute their message, token, and tool
  usage back to the root session without double counting.
- Each message's `parts` are indexed; preserving the order matters for reasoning-token correctness.
- Tokens are reported across `input`, `output`, `reasoning`, `cache.read`, and `cache.write`. Anthropic semantics.
- External MCP tools are stored as `<server>_<tool>` names (for example
  `clickup_clickup_get_task`). The provider normalizes those to CodeBurn's
  canonical `mcp__<server>__<tool>` names before aggregation so shared MCP
  panels and `optimize` findings count OpenCode usage.

## When fixing a bug here

1. The provider test suite catches a lot. Run `npm test -- tests/providers/opencode.test.ts` before and after any change.
2. If the bug is "missing table" warning, do not catch and silence it. Either upgrade the version expectation in the parser or document the breaking schema change.
3. If the bug is "reasoning tokens off by one", check the parts index ordering.
