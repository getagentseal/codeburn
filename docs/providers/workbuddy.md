# WorkBuddy and WorkBuddy AI

WorkBuddy and WorkBuddy AI are AI coding assistant applications that store their session transcripts in `~/.workbuddy` and `~/.workbuddy-ai` respectively.

## Storage layout

```
~/.workbuddy/projects/<project-slug>/<uuid>.jsonl             transcript
~/.workbuddy/projects/<project-slug>/<uuid>.file-rollback.ndjson   rollback log (skipped)
~/.workbuddy/projects/<project-slug>/<uuid>.meta.json         connection metadata (skipped)
~/.workbuddy-ai/projects/<project-slug>/<uuid>.jsonl          transcript
```

Environment variable overrides:
- `WORKBUDDY_HOME`: overrides root for WorkBuddy (default `~/.workbuddy`)
- `WORKBUDDY_AI_HOME`: overrides root for WorkBuddy AI (default `~/.workbuddy-ai`)

Transcripts reside in `<root>/projects/<project-slug>/*.jsonl`.

## Data format and quirks

- Lines with `providerData.rawUsage` (either `message` with `role: 'assistant'` or `function_call`) record model completions and token usages.
- Token counts are mapped from `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens` (cacheReadInputTokens), and `completion_tokens_details.reasoning_tokens` (reasoningTokens).
- Tool calls are represented as `function_call` entries with a `name` and `arguments`.
- Project path is resolved from the transcript's initial `cwd` attribute if available, or decoded from the slug (e.g. `c-Users-...` -> `C:\Users\...`).
- User prompts often start with `<system-reminder>...</system-reminder>` and contain `<user_query>...</user_query>`, from which the actual user prompt is extracted.
