# DeepSeek Harness (dsh)

DeepSeek's open-source agent harness (`dsh`, npm `@deepseek-ai/dsh`). Unrelated to the [CodeWhale](codewhale.md) provider, which reads the DeepSeek desktop app.

- **Source:** `src/providers/dsh.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/dsh.test.ts`

## Where it reads from

| Level | Env var | Default |
|---|---|---|
| sessions | — | `<root>/sessions` |
| root | `DSH_HOME` | `~/.dsh` |

An empty `DSH_HOME` is treated as unset. `probeRoots()` reports the resolved sessions dir, so `codeburn doctor` distinguishes "dsh not installed" from "`DSH_HOME` pointing somewhere empty". When discovery skips unknown highest generations, doctor reports `skippedVersionCount` in JSON and the skipped session count in its error verdict. Warnings are emitted once per unknown version, while every excluded session contributes to the count.

## Storage format

```
sessions/--<slugified-cwd>--/<session-id>/
  session.jsonl[.zstd]       format v0
  session.v1.jsonl[.zstd]    format v1
  session.v2.jsonl[.zstd]    format v2
  session.v3.jsonl[.zstd]    format v3
```

Separate sessions are all counted, including sessions with only legacy v0/v1
logs alongside sessions using v2/v3. Generation selection applies only within
one session directory; a newer-format session never supersedes another session.

Both compression variants are read. Migrated generations are immutable and may
coexist; CodeBurn selects the numerically highest canonical generation per
Session. If that generation is unknown, corrupt, or disagrees with its header,
the Session is skipped with a notice instead of silently falling back to an
older snapshot. The log is append-only JSONL whose first line is the session header:

```jsonc
{ "type": "session", "version": 0, "id": "...", "createdAt": 1783352050748,
  "cwd": "/home/u/proj", "parentSession": "...", "seedLength": 3, "delegationDepth": 0 }
```

`cwd` becomes `projectPath` / `workingDirectory` (git-repo attribution) and its last segment the project name.

Every later line is one event `{ type, seq, time, data }`. Formats v0/v1 keep
stream chunks as top-level events (with delta runs packed into storage rows).
Formats v2/v3 embed the compact stream in each `assistant/message` or
`assistant/attempt`. The parser reads:

| Event | Used for |
|---|---|
| `turn/start` | current turn number |
| `user/message` | the turn's preview, when `data.source.kind === 'user'` |
| `request/header` | `data.header.config.model` — the model for steps that follow |
| `assistant/chunk` with `chunk.type === 'usage'` | v0/v1 streamed usage sample for `(turn, step)` |
| `assistant/message` | successful attempt; top-level usage wins, then embedded stream usage; plus `data.message.source.model` |
| `assistant/attempt` | failed/retried attempt usage from its embedded stream |
| `llm/retry-started` | closes the replacement slot so the next settlement is an additional billed attempt |
| `request/context` | actual route/model fallback for attempts without a successful message |
| `tool/call` | tool names, bash commands, skill names |

One parsed call per model attempt. The first attempt keeps dedup key
`dsh:<sessionId>:<turn>:<step>`; retries add `:attempt:<n>`.

`.zstd` logs are a concatenation of **independent** zstd frames, one per write batch, so they are decoded frame by frame behind a structural frame scan ported from `@deepseek-ai/dsh-session-persistence-jsonl`. Needs Node 22.15+ for `zlib.zstdDecompressSync`; below that dsh is skipped with a notice instead of counted as $0.

## Caching

None at the provider level; the log file is the cached source path and the normal parser/cache layers apply. Cache invalidates on `DSH_HOME` (`PROVIDER_ENV_VARS`) and on parser changes (`PROVIDER_PARSE_VERSIONS`).

## Quirks

- **DSH is a developer preview.** The parser explicitly supports released formats v0-v3 and checks both the canonical generation filename and header. A future version is skipped with a notice; **a version bump upstream still requires a semantic reader update, not just relaxing the check.**
- **The JSONL backend only.** DSH also ships an opt-in SQLite persistence backend (`@deepseek-ai/dsh-session-persistence-sqlite`); it is not the default and is not read.
- **DSH records tokens, never dollars.** `usage` is `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }` with no cost field, so every call is priced from the shared tables. The buckets are disjoint on input; `reasoningTokens` is informational detail already included in `outputTokens`, as documented in the [DSH TokenUsage contract](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/subsystems/llm-streaming.md#tokenusage). CodeBurn preserves raw output and applies the shared inclusive-output rule to pricing, cached reads, and display. pi-ai routes do not persist separate reasoning detail. Complete valid usage keeps `costIsEstimated` false; incomplete or inconsistent usage is reported with a notice and marked estimated. An attempt without usage is omitted with a notice rather than represented as an exact zero.
- **`assistant/message` usage wins over the `assistant/chunk` sample** for the same `(turn, step)` — the two are adjacent reports of one API call, not two calls. A late chunk never overwrites a final report, so the two are never summed.
- **The model comes from the message, not the request.** `data.message.source.model` is what actually served the step; the current `request/context` model is the fallback, followed by `request/header`. A changed header model clears the previous context fallback. The `provider` field there (`deepseek-official`) is the upstream LLM route, not the tool — the codeburn provider name is always `dsh`.
- **A forked session's log replays its parent's events.** v0/v1 use header `seedLength` only when `parentSession` is present, preserving the legacy non-fork behavior; v2/v3 use the last `session/end-seed` marker carrying `{ inherited: true }`. CodeBurn excludes the inherited prefix to avoid billing the parent's calls twice.
- **`user/message` also carries agent-injected context** (runtime snapshots, skill bodies, file-change notices) under `source.kind: 'plugin'`. Only `kind: 'user'` messages become the preview.
- **Delta chunks are packed.** Runs of streamed deltas are stored as `text-chunks` / `reasoning-chunks` / `tool-call-chunks` storage rows rather than one event per line. They carry no usage and no tool identity the `tool/call` event lacks, so they are ignored — as is any event type the parser does not know.
- **A torn final zstd frame is ignored.** A crashed writer leaves an incomplete trailing frame; the complete frames before it parse normally. A structurally corrupt file is skipped whole with a notice rather than throwing.

## When fixing a bug here

`v3-retry.jsonl` also covers a failed `assistant/attempt`, scheduled retry, and successful settlement with exact `totalTokens`. The same official strict restore and reducer yield input 110, output 24, cache read 33, and cache write 7 (174 total tokens).

1. Reproduce with a minimal session dir: `sessions/--proj--/<id>/session.jsonl` (uncompressed is easiest to hand-write).
2. `tests/fixtures/dsh/bash-tool-turn.jsonl` is the upstream `examples/acp-agent/tests/snapshots/bash-tool-turn/session.jsonl` snapshot with its template placeholders filled in — refresh it from the DSH repo when the format moves.
3. Run `tests/providers/dsh.test.ts`.
4. `.zstd` fixtures must compress **each batch separately**; one `zstdCompressSync` over the whole file is a single-frame layout DSH never writes.
5. `tests/fixtures/dsh/v0.jsonl` through `v3.jsonl` are minimal synthetic, sanitized format fixtures. Each was restored with DSH's official `sessionFormatCatalog` (`recovery: 'strict', validation: 'current'`) and folded through `tokenUsageProjectionDefinition` at DSH commit `c291e7961a515f6d7af9304e7fd1d257929aef26`. All four yield uncached input 100, full output 20, cache read 30, and cache write 5; the provider tests assert those buckets, including inclusive output and informational reasoning detail. v0/v1 cite their top-level chunk via `sourceEventSeqs`; v2/v3 carry the embedded stream.
