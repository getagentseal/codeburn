# Provider Docs

One file per provider integration. If you are fixing a bug or adding a feature scoped to a single provider, read the file for that provider first; it tells you which file to edit, where on disk the source data lives, and what edge cases the test suite already covers.

For the architectural picture, see `../architecture.md`.

## Provider Index

### Eager (always loaded)

| Provider | Storage | Source | Test |
|---|---|---|---|
| [Claude](claude.md) | JSONL (no parser) | `src/providers/claude.ts` | none (covered indirectly) |
| [Cline](cline.md) | JSON | `src/providers/cline.ts` | `tests/providers/cline.test.ts` |
| [CodeWhale](codewhale.md) | JSON | `src/providers/codewhale.ts` | `tests/providers/codewhale.test.ts` |
| [Codex](codex.md) | JSONL | `src/providers/codex.ts` | `tests/providers/codex.test.ts` |
| [Copilot](copilot.md) | JSONL + SQLite (OTel) + Nitrite .db (JetBrains) | `src/providers/copilot.ts` | `tests/providers/copilot.test.ts` |
| [Devin](devin.md) | JSON + SQLite enrichment | `src/providers/devin.ts` | `tests/providers/devin.test.ts` |
| [Droid](droid.md) | JSONL | `src/providers/droid.ts` | `tests/providers/droid.test.ts` |
| [Gemini](gemini.md) | JSON / JSONL | `src/providers/gemini.ts` | none |
| [Hermes Agent](hermes.md) | SQLite | `src/providers/hermes.ts` | `tests/providers/hermes.test.ts` |
| [IBM Bob](ibm-bob.md) | JSON | `src/providers/ibm-bob.ts` | `tests/providers/ibm-bob.test.ts` |
| [KiloCode](kilo-code.md) | JSON | `src/providers/kilo-code.ts` | `tests/providers/kilo-code.test.ts` |
| [Kiro](kiro.md) | JSON | `src/providers/kiro.ts` | `tests/providers/kiro.test.ts` |
| [Kimi](kimi.md) | JSONL | `src/providers/kimi.ts` | `tests/providers/kimi.test.ts` |
| [LingTai TUI](lingtai-tui.md) | JSONL | `src/providers/lingtai-tui.ts` | `tests/providers/lingtai-tui.test.ts` |
| [Mistral Vibe](mistral-vibe.md) | JSON / JSONL | `src/providers/mistral-vibe.ts` | `tests/providers/mistral-vibe.test.ts` |
| [OpenClaw](openclaw.md) | JSONL | `src/providers/openclaw.ts` | `tests/providers/openclaw.test.ts` |
| [Pi](pi.md) | JSONL | `src/providers/pi.ts` | `tests/providers/pi.test.ts` |
| [OMP](omp.md) | JSONL | `src/providers/pi.ts` | `tests/providers/omp.test.ts` |
| [Qwen](qwen.md) | JSONL | `src/providers/qwen.ts` | none |
| [Quick Desktop](quickdesk.md) | EMF JSONL + SQLite | `src/providers/quickdesk.ts` | `tests/providers/quickdesk.test.ts` |
| [Roo Code](roo-code.md) | JSON | `src/providers/roo-code.ts` | `tests/providers/roo-code.test.ts` |
| [Zerostack](zerostack.md) | JSON | `src/providers/zerostack.ts` | `tests/providers/zerostack.test.ts` |
| [Grok Build](grok.md) | JSON/JSONL | `src/providers/grok.ts` | `tests/providers/grok.test.ts` |

### Lazy (loaded on first call)

| Provider | Storage | Source | Test |
|---|---|---|---|
| [Antigravity](antigravity.md) | protobuf over RPC | `src/providers/antigravity.ts` | none |
| [Crush](crush.md) | SQLite (per-project) | `src/providers/crush.ts` | `tests/providers/crush.test.ts` |
| [Forge](forge.md) | SQLite | `src/providers/forge.ts` | `tests/providers/forge.test.ts` |
| [Cursor](cursor.md) | SQLite | `src/providers/cursor.ts` | `tests/providers/cursor.test.ts` |
| [Cursor Agent](cursor-agent.md) | text / JSONL | `src/providers/cursor-agent.ts` | `tests/providers/cursor-agent.test.ts` |
| [Goose](goose.md) | SQLite | `src/providers/goose.ts` | none |
| [OpenCode](opencode.md) | SQLite | `src/providers/opencode.ts` | `tests/providers/opencode.test.ts` |
| [Warp](warp.md) | SQLite | `src/providers/warp.ts` | `tests/providers/warp.test.ts` |
| [Vercel AI Gateway](vercel-gateway.md) | REST API | `src/providers/vercel-gateway.ts` | `tests/providers/vercel-gateway.test.ts` |
| [ZCode](zcode.md) | SQLite | `src/providers/zcode.ts` | `tests/providers/zcode.test.ts` |

### Shared

| Helper | Used by | Source |
|---|---|---|
| [vscode-cline-parser](vscode-cline-parser.md) | `cline`, `ibm-bob`, `kilo-code`, `roo-code` | `src/providers/vscode-cline-parser.ts` |

## File Format

Each provider doc has the same structure:

1. **One-line summary** of what the provider integrates.
2. **Where it reads from** on disk (or over RPC).
3. **Storage format** and validation rules.
4. **Caching** (which cache layer, if any).
5. **Deduplication key** so you understand cross-provider dedup.
6. **Quirks** that have bitten us before.
7. **When fixing a bug here** as a checklist.

If you add a new provider, copy `claude.md` as a template and fill in your provider's specifics. Update this index, and prefer adding a real test fixture under `tests/providers/`.
