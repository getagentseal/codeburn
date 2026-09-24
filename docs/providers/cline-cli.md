# Cline CLI

The Cline command-line agent (npm `cline`, 3.x). Separate from the [Cline](cline.md) provider, which reads the VS Code extension's task tree.

- **Source:** `src/providers/cline-cli.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/cline-cli.test.ts`

## Where it reads from

One root, resolved exactly as the CLI resolves it — each level independently overridable:

| Level | Env var | Default |
|---|---|---|
| sessions | `CLINE_SESSION_DATA_DIR` | `<data>/sessions` |
| data | `CLINE_DATA_DIR` | `<root>/data` |
| root | `CLINE_DIR` | `~/.cline` |

A directory is a session only when it contains `<sessionId>/<sessionId>.json`. `probeRoots()` reports the resolved sessions dir, so `codeburn doctor` distinguishes "CLI not installed" from "override pointing somewhere else".

## Storage format

```
sessions/<sessionId>/
  <sessionId>.json           metadata + rolled-up usage
  <sessionId>.messages.json  per-message metrics
```

`<sessionId>.json` carries `session_id`, `provider`, `model`, `cwd`, `workspace_root`, `started_at` / `ended_at`, `messages_path`, and a `metadata.usage` rollup (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalCost`).

`<sessionId>.messages.json` holds `{ version, updated_at, agent, sessionId, messages[], system_prompt }`. Assistant messages carry Anthropic-style content blocks (`thinking` / `text` / `tool_use`) plus:

```jsonc
"modelInfo": { "id": "z-ai/glm-5.2", "provider": "cline-pass" },
"metrics": { "inputTokens": 6937, "outputTokens": 213,
             "cacheReadTokens": 0, "cacheWriteTokens": 0, "cost": 0.002108502 }
```

One `metrics` block becomes one parsed call. Dedup key: `cline-cli:<sessionId>:<messageId>`.

## Caching

None at the provider level; the metadata file is the cached source path and the normal parser/cache layers apply.

## Quirks

- **`provider` in the session file is the upstream LLM route** (e.g. `cline-pass`), not the tool. The codeburn provider name is always `cline-cli`.
- **Model strings are not normalized by the CLI.** The same model appears as `z-ai/glm-5.2`, `cline-pass/glm-5.2`, and `GLM-5.2` across sessions, so pricing lookups may need a `model-alias`.
- **Cost is reported per message**, so `costIsEstimated` is false on the normal path; it falls back to `calculateCost` only when a message omits `cost`.
- **Rollup fallback.** A session whose messages carry no metrics (interrupted, or an older layout) emits a single call from `metadata.usage`. This reads `usage`, deliberately *not* `aggregateUsage` / `aggregatedAgentsCost`, which fold in spawned subagents that are themselves separate session directories and would double count.
- **`messages_path` is absolute** and goes stale when a session directory is copied between machines, so the co-located `<sessionId>.messages.json` is preferred and `messages_path` is only the fallback.
- **Tool names differ from the extension's.** `run_commands`, `read_files`, `search_codebase`, `editor`, `apply_patch`, `fetch_web_content`, `skills`, `spawn_agent`, and the `team_*` family. `run_commands` carries a JSON-encoded array of command lines in a single string field.

## When fixing a bug here

1. Reproduce with a minimal session directory: `<id>.json` plus `<id>.messages.json`.
2. Run `tests/providers/cline-cli.test.ts`.
3. This provider shares no code with `vscode-cline-parser.ts` — changes here cannot affect Cline, KiloCode, or IBM Bob.
