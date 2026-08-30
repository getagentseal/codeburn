# Bahulam Code

Bahulam Code — open-source coding agent.

- **Source:** `src/providers/bahulam.ts`
- **Loading:** eager (`src/providers/index.ts` `coreProviders`)
- **Test:** `tests/providers/bahulam.test.ts`

## Where it reads from

`~/.bahulam/projects/`. Honors `BAHULAM_PROJECTS_DIR` env override, matching opentab's convention.

## Storage format

JSONL. Each file is one session under a project slug directory:

```
~/.bahulam/projects/<project-slug>/<session-id>.jsonl
```

The wire format uses `bahulam_event` / `kepler_event` as the top-level type. Per-turn token usage and cost live in `event.data.usage` on `complete` events. Every record carries `type`, `timestamp`, and `cwd` at the top level.

## Caching

None at the provider level; the normal parser/cache layers apply.

## Deduplication

Per source path plus a complete-event key: `bahulam:<sourcePath>:<responseId>` when the usage has a response id, otherwise `bahulam:<sourcePath>:<timestamp>:<lineIndex>`. Multi-model rows append `:model:<index>:<model>`, while sharing the same turn id.

## Cost

Bahulam records per-turn cost on `complete` events. Reported costs, including `$0`, are passed through; absent or invalid costs fall back to LiteLLM pricing and are flagged `costIsEstimated: true`.

## Quirks

- Session ID is the filename stem (`basename(path, '.jsonl')`). There is no `sessionId` field inside records.
- Cache write 1h-TTL tokens are extracted from `usage.cache_creation.ephemeral_1h_input_tokens`.
- Model names may be bare strings (e.g. `deepseek-v4-pro`). The provider prefixes known families (`openai/`, `anthropic/`, `google/`, `deepseek/`) for LiteLLM pricing lookup.
- Tools are extracted from `tool_call` / `tool_request` events and queued for the next `complete` turn.
- No subagent / sidecar transcripts — each JSONL file is one self-contained session.
