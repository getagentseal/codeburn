# Kimi Code

MoonshotAI Kimi Code local session usage and tool activity.

- **Source:** `src/providers/kimicode.ts`
- **Loading:** eager
- **Test:** `tests/providers/kimicode.test.ts`

## Where it reads from

By default the provider scans every known Kimi Code runtime store:

```text
~/.kimi-code
~/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home   (Kimi desktop / IDE embedded runtime)
```

Setting `KIMI_CODE_HOME` (or passing a home override) narrows the scan to that single home. Inside each home it scans:

```text
$HOME/sessions/wd_*/<session-dir>/
├── state.json
└── agents/<agent-id>/wire.jsonl
```

Session directory naming depends on the host product: the CLI uses `session_*`, embedded runtimes use `conv-*` / `ctitle-*`. Any directory is accepted; the `agents/*/wire.jsonl` probe gates real sessions.

Every agent wire is a cache source. Main-agent and subagent calls share the session ID from the `session_*` directory. `state.json.workDir` supplies the project name and path. `probeRoots()` reports the resolved Kimi Code home for `codeburn doctor` even when there are no sessions.

## Storage format

`wire.jsonl` contains one event per line. The parser uses:

- `turn.prompt.input` for the current user message.
- `llm.request.model` for the real model ID and the turn prefix from `turnStep`.
- `context.append_loop_event.event` when its type is `tool.call`; the event's `name` feeds the tool breakdown.
- `usage.record.usage` for billed tokens.

Token fields map as follows:

| Kimi Code | CodeBurn |
|---|---|
| `inputOther` | input |
| `output` | output |
| `inputCacheRead` | cache read and cached input |
| `inputCacheCreation` | cache write |

`usage.record.model` is only the configured alias. The parser resolves that alias through observed `llm.request` events to obtain the real model ID used for pricing and reports, falling back to the nearest preceding request when the alias is empty or unknown. Kimi Code records no cost, so CodeBurn computes it from the four token categories with `calculateCost` and marks it estimated.

Malformed JSONL lines are skipped independently. A failed session containing retrying `llm.request` events but no `usage.record` events emits no calls and therefore contributes zero usage. Retry `attempt` values are not interpreted.

## Caching

Kimi Code is an eager provider using the shared session cache. Each agent's `wire.jsonl` is fingerprinted separately. `KIMI_CODE_HOME` and the Kimi Code parser version participate in the provider cache fingerprint.

## Deduplication

Usage calls use `kimicode:<session-id>:<agent-id>:<line-number>:<usage-ordinal>`. Including the agent ID keeps main-agent and subagent events distinct, while stable line positions prevent a wire from being counted twice across parses.

This agent-and-position-scoped key relies on the store invariant that each agent's `usage.record` events appear only in its own `wire.jsonl`, as identified by the `state.json` agents map. If a future Kimi Code version mirrors subagent usage into the main wire, the key must become content-scoped.

## Quirks

- Multi-turn continuations append to the same wire. The numeric prefix of `llm.request.turnStep` groups multiple model steps into the correct turn.
- Tools are attached to the next `usage.record` in the same wire and then cleared, so each `tool.call` contributes once.
- Kimi Code is the successor to the legacy `kimi-cli`. Kimi Code migrates predecessor configuration and sessions into its own store; this provider intentionally does not parse the old `~/.kimi` layout.

## When fixing a bug here

1. Keep real-model attribution based on `llm.request.model`; never report the alias from `usage.record.model`.
2. Test main and subagent wires together with a shared deduplication set.
3. Preserve malformed-line and retry-only coverage when adding event variants.
4. Keep fixtures sanitized and rooted in a temporary `KIMI_CODE_HOME`.

## Subagent accounting (verified at source)

Subagent token usage is recorded only in the subagent's own `wire.jsonl`.
When a subagent completes, the parent's wire receives a `subagent.completed`
summary event (informational, ignored by this parser), never a `usage.record`
mirroring the child's tokens (see MoonshotAI/kimi-code,
`packages/agent-core/src/session/subagent-host.ts`). Summing `usage.record`
events across all agent wires therefore does not double count.
