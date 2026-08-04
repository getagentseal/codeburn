# OpenClaude

OpenClaude (npm `@gitlawb/openclaude`) is a Claude Code fork that runs the same
agent loop against any LLM backend (DeepSeek, OpenAI-compatible endpoints,
Gemini, Ollama, ...). Because it is a fork, its transcripts are Claude-Code
schema and its tool names are already codeburn-canonical.

## Storage layout

```
~/.openclaude/projects/<project-slug>/<uuid>.jsonl        transcript
~/.openclaude/projects/<project-slug>/<uuid>.replay.json  replay state (skipped)
```

`CODEBURN_OPENCLAUDE_DIR` overrides the root (projects live under
`<root>/projects`).

## Quirks

- Only `assistant` lines carrying `message.usage` become calls; the
  `queue-operation` / `last-prompt` bookkeeping lines and user lines are
  skipped.
- Usage is Anthropic-shaped; there is NO cost field, so every call is priced
  through the shared tables and always carries `costIsEstimated: true`.
- `isSidechain: true` lines are subagent traffic inside the same transcript
  and are counted: their usage is real spend.
- The model id is whatever the routed backend reports (e.g. `deepseek-chat`),
  so pricing accuracy tracks the shared litellm tables.
- Tool attribution is partial by construction: streamed responses can split
  tool_use blocks across assistant events, and only usage-bearing events are
  parsed. Cost and token accounting are exact; tool breakdowns are a floor.
- The project name prefers the basename of the first `cwd` seen in the
  transcript; the project-slug directory is the fallback.
