# LingTai TUI

LingTai TUI per-agent token ledger integration.

- **Source:** `src/providers/lingtai-tui.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/lingtai-tui.test.ts`

## Where it reads from

| Source | Path |
|---|---|
| Explicit LingTai homes | `$LINGTAI_HOME` or `$LINGTAI_TUI_HOME` if set; path-list values are supported |
| Default LingTai home | `~/.lingtai` |
| Project LingTai homes | `<project>/.lingtai` for projects registered in `~/.lingtai-tui/registry.jsonl` and `~/.lingtai-tui/brief/projects/*/meta.json` |
| Current worktree home | `.lingtai` in the current directory or any parent directory |
| Agent ledgers | `<lingtai-home>/<agent>/logs/token_ledger.jsonl` |

Daemon ledgers nested under `<agent>/daemons/...` are deliberately not discovered during normal scanning. LingTai mirrors daemon usage into the parent agent ledger with `source`, `em_id`, and `run_id` tags, so reading nested ledgers too would double count spend.

## Storage format

Append-only JSONL. Each valid ledger line may include:

- `source`
- `em_id`
- `run_id`
- `ts`
- `input`
- `output`
- `thinking`
- `cached`
- `model`
- `endpoint`

Malformed lines and zero-token entries are skipped. Missing `model` falls back to the agent `.agent.json` `llm.model`, then `unknown`.

## Parser

CodeBurn emits one parsed call per ledger entry. LingTai records provider-normalized total input plus a separate `cached` counter, so the provider maps:

- `input - cached` -> fresh input tokens
- `cached` -> cache-read tokens
- `output` -> output tokens
- `thinking` -> reasoning tokens

Costs are calculated from CodeBurn's normal model pricing table.

## Activity mapping

LingTai's token ledger is an accounting source, not full chat history, so it does not include the original user prompt or per-tool transcript. CodeBurn maps the ledger `source` field conservatively:

| LingTai `source` | CodeBurn activity |
|---|---|
| `main` and unknown sources | Conversation |
| `tc_wake` and other task-coordinator wake sources | Delegation |
| `daemon` | Delegation |
| `summarize_apriori` | Planning |

This keeps the menubar and dashboard **By Activity** view from collapsing all LingTai usage into Conversation while avoiding invented feature/debug/refactor semantics that the ledger cannot prove.

## Project grouping

Discovery reads `<agent>/.agent.json` and groups by `nickname`, `agent_name`, `address`, then the directory name. Project-local homes are prefixed with the project directory name, for example `sample-project-Project Agent`, so same-named agents from different LingTai projects do not collapse together. The parsed call also carries the agent directory as `projectPath`.

## Caching

The shared session cache fingerprints each `token_ledger.jsonl`. `LINGTAI_HOME`, `LINGTAI_TUI_HOME`, and `LINGTAI_TUI_GLOBAL_DIR` are part of the provider environment fingerprint so changing homes invalidates stale cached results.

## Deduplication

Dedup keys include provider name, ledger path, line number, timestamp, model, endpoint, LingTai source tags, and token counts:

`lingtai-tui:<ledger-path>:<line>:<timestamp>:<model>:...`

The ledger is append-only, so line number is stable for normal operation.

## Quirks

- Tool calls are not reconstructed from chat history. The token ledger is the stable accounting source and does not include tool metadata.
- Older ledger entries may not include `source`; those are labeled `main`.
- `cached` is treated as cache read. LingTai does not expose a separate cache creation counter in the ledger.

## When fixing a bug here

1. Prefer a minimal redacted `token_ledger.jsonl` fixture over full `chat_history.jsonl`.
2. Check whether a daemon entry is already mirrored into the parent ledger before adding new discovery paths.
3. Run `npm test -- tests/providers/lingtai-tui.test.ts --run`.
