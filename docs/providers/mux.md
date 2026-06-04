# Mux

[coder/mux](https://github.com/coder/mux) — Coder's desktop/CLI app for parallel agentic development. Mux makes its own LLM API calls (via the Vercel AI SDK) and records per-turn token usage natively, so codeburn reads it directly.

- **Source:** `src/providers/mux.ts`
- **Loading:** eager (`src/providers/index.ts:13`)
- **Test:** `tests/providers/mux.test.ts`

## Where it reads from

| Order | Path |
|---|---|
| 1 | `$CODEBURN_MUX_DIR` (codeburn-only override) |
| 2 | `$MUX_ROOT` (mux's own override) |
| 3 | `~/.mux` (default) |

Session files: `<root>/sessions/<workspaceId>/chat.jsonl`. Dev builds of mux use `~/.mux-dev` and an older install may use `~/.cmux` (migrated to `~/.mux`); point `CODEBURN_MUX_DIR`/`MUX_ROOT` at those if needed.

The human-readable project name is resolved from `<root>/config.json` (shape: `{ projects: Array<[projectPath, { workspaces: [{ id }] }] > }`); the directory under `sessions/` is the `workspaceId`, matched against `workspace.id`. Falls back to the raw `workspaceId` when there's no mapping.

## Storage format

JSONL, one `MuxMessage` per line. Token usage rides on each assistant message's `metadata.usage` (`{ inputTokens, outputTokens, reasoningTokens, cachedInputTokens }`, typed `z.any()` upstream so it's read defensively). Tool calls and the user prompt are `parts[]` entries (`dynamic-tool` / `text`).

## Pricing

Cost is recomputed locally via `calculateCost` (mux and codeburn both price from the LiteLLM snapshot). On-disk model strings are `provider:modelId` (e.g. `anthropic:claude-opus-4-8`); the `provider:` prefix is stripped **at parse time** so the stored model is the bare LiteLLM id. This matters because codeburn's canonicalizer (`getCanonicalName`) only strips slash-style prefixes, and `parser.ts` re-prices from the stored model after the cache round-trip — a colon-prefixed model would price at $0 and render raw in the breakdown.

Token decomposition matches mux's own `displayUsage.ts` (AI SDK v6 semantics):

- `inputTokens` is **inclusive** of cache-read and cache-creation → `input = inputTokens − cachedInputTokens − cacheCreation`.
- `outputTokens` is **inclusive** of reasoning → `output = outputTokens − reasoning`; reasoning bills at the output rate, so it's folded back into the output arg of `calculateCost`.
- Cache-creation tokens are provider-specific: read from `metadata.providerMetadata.anthropic.cacheCreationInputTokens`.

## Caching

None at the provider level.

## Deduplication

Per `mux:<workspaceId>:<message.id>`. `message.id` is required by mux's schema; for corrupt id-less lines it falls back to the (unique) line index.

## Quirks

- **No double-counting with `claude`.** Mux calls model APIs itself and stores usage under `~/.mux`; it does not shell out to Claude Code or read `~/.claude`. Sub-agents are internal child workspaces, each with their own `sessions/<id>/chat.jsonl`, so per-workspace parsing counts each call once.
- **Read only `chat.jsonl`.** `session-usage.json` (pre-aggregated per model) and `analytics/analytics.db` (DuckDB, derived from `chat.jsonl`) describe the *same* usage; summing them would double-count.
- **No web-search field.** Mux records no web-search/server-tool request count, so `webSearchRequests` is always `0`.
- **Remote runtimes.** Mux can run workspaces on SSH/Docker, but the desktop app is the LLM client and writes `sessions/*/chat.jsonl` on the machine running mux — so usage is captured locally regardless of where commands execute.

## When fixing a bug here

1. Confirm whether the bug is in **discovery** (sessions not picked up — `discoverSessions`/`loadProjectMap`) or **parsing** (`createParser`).
2. `metadata.usage` is untyped upstream and its exact field set varies by provider family (anthropic/openai/google/xai/deepseek). Validate against a real `chat.jsonl` sample and cross-check the parsed per-model totals against the sibling `session-usage.json` `byModel` — they should match.
3. Add a fixture-driven case to `tests/providers/mux.test.ts`. Do not mock the filesystem; write a temp `~/.mux` layout like the existing tests.
