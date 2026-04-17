# CodeBurn Codebase Overview

## Tech Stack

- **Language**: TypeScript (strict mode), ESM modules
- **Runtime**: Node.js >= 20
- **Build**: tsup (single ESM bundle `dist/cli.js` with shebang)
- **Test**: Vitest (5 test files)
- **TUI**: Ink 7 (React 19 for terminals)
- **CLI**: Commander.js
- **Optional**: better-sqlite3 (for Cursor provider)

## Architecture: Pipeline with Provider Plugin System

```
CLI (commander) -> Provider Discovery -> Session Parsing -> Cost Calculation -> Classification -> Output
```

Not layered, not hexagonal -- a straightforward data pipeline where each stage transforms the data forward. No dependency injection, no abstract interfaces beyond the `Provider` type.

## Module Map (18 source files)

| Module | Role | Lines |
|--------|------|-------|
| `cli.ts` | Entry point, Commander setup, 7 commands | 276 |
| `types.ts` | Core domain types (TokenUsage, ParsedApiCall, SessionSummary, etc.) | 151 |
| `parser.ts` | Main orchestrator: discovers sessions, parses JSONL, groups into turns, builds summaries | 508 |
| `models.ts` | Pricing: fetches LiteLLM JSON, 24h disk cache, hardcoded fallbacks, cost calculation | 191 |
| `classifier.ts` | Classifies turns into 13 categories by tool+keyword patterns | 163 |
| `dashboard.tsx` | Ink/React TUI: gradient bars, responsive panels, keyboard navigation, auto-refresh | 668 |
| `format.ts` | Token/cost formatting helpers, status bar renderer | 42 |
| `export.ts` | CSV/JSON export with CSV injection protection | 217 |
| `menubar.ts` | macOS SwiftBar/xbar plugin generation and install/uninstall | 264 |
| `config.ts` | Read/write `~/.config/codeburn/config.json` | 37 |
| `currency.ts` | Currency conversion via Frankfurter API, 24h cache | 141 |
| `bash-utils.ts` | Extract command basenames from bash strings (handles pipes, `&&`, quotes) | 43 |
| `sqlite.ts` | Lazy better-sqlite3 loader with typed wrapper | 59 |
| `cursor-cache.ts` | Cache Cursor query results keyed by DB mtime+size | 64 |
| `providers/types.ts` | Provider interface: `discoverSessions()`, `createSessionParser()` | 38 |
| `providers/index.ts` | Provider registry, lazy Cursor loading | 50 |
| `providers/claude.ts` | Claude Code: discovers JSONL dirs in `~/.claude/projects` + desktop app | 106 |
| `providers/codex.ts` | Codex: discovers JSONL in `~/.codex/sessions/YYYY/MM/DD/`, async generator parser | 306 |
| `providers/cursor.ts` | Cursor: queries SQLite `state.vscdb`, bubble-based token extraction | 284 |

## Provider System

Each provider implements the `Provider` interface:

- **Claude**: Session discovery only (parsing happens in `parser.ts` via legacy JSONL path). `createSessionParser()` is a no-op -- Claude sessions are still parsed by `parser.ts`'s `scanProjectDirs` directly reading JSONL.
- **Codex**: Full provider -- discovers sessions in dated directory structure, parses via async generator. Normalizes OpenAI token semantics (cached tokens included in input) to Anthropic semantics.
- **Cursor**: Full provider -- reads SQLite `cursorDiskKV` table, extracts bubble data, deduplicates by conversation+timestamp+tokens. Results are cached to disk.

**Key asymmetry**: Claude sessions go through `scanProjectDirs` -> `parseSessionFile` -> `groupIntoTurns` (the original codepath), while Codex/Cursor go through `parseProviderSources` which uses the `SessionParser` async generator interface. Both paths merge in `parseAllSessions`.

## Data Model

```
Provider -> SessionSource (path, project, provider)
         -> ParsedProviderCall (per API call, normalized)
         -> ParsedTurn (user message + assistant calls)
         -> ClassifiedTurn (+ category, retries, hasEdits)
         -> SessionSummary (aggregated breakdowns)
         -> ProjectSummary (grouped by project)
```

## Classification System

13 task categories, two-phase classification:

1. **Tool-based**: Plan mode -> delegation -> bash patterns (test/git/build) -> edits -> exploration
2. **Keyword refinement**: Coding refines to debugging/refactoring/feature; exploration refines to debugging
3. **Conversation fallback**: brainstorm/research/debug/feature keywords, file patterns, URLs

## Caching Strategy

- **LiteLLM pricing**: 24h disk cache at `~/.cache/codeburn/litellm-pricing.json`
- **Exchange rates**: 24h disk cache at `~/.cache/codeburn/exchange-rate.json`
- **Session results**: In-memory LRU (10 entries, 60s TTL) in `parser.ts`
- **Cursor results**: Disk cache keyed by DB mtime+size at `~/.cache/codeburn/cursor-results.json`

## Deduplication

- **Claude**: API message ID (`msg.id`), tracked in `Set<string>` of seen IDs
- **Codex**: Cumulative total token cross-check (skips if total unchanged), plus `codex:path:timestamp:total` dedup key
- **Cursor**: `cursor:conversationId:createdAt:inputTokens:outputTokens` dedup key

## CLI Commands

1. `report` (default) -- interactive TUI dashboard with period switching
2. `today` -- shortcut for `report -p today`
3. `month` -- shortcut for `report -p month`
4. `status` -- compact output, supports `--format menubar|json|terminal`
5. `export` -- CSV/JSON with Today + 7d + 30d periods
6. `install-menubar` / `uninstall-menubar` -- macOS SwiftBar/xbar plugin
7. `currency [code]` -- set display currency

## Testing Patterns

- **Vitest** with temp directory fixtures (mkdtemp/rm)
- Tests cover: bash command extraction, CSV injection prevention, provider registry, Codex JSONL parsing, Cursor provider basics
- No tests for: `parser.ts` (the main orchestrator), `classifier.ts`, `dashboard.tsx`, `models.ts` pricing logic, `currency.ts`

## Key Conventions

- No `any` types, strict TypeScript
- Single quotes, no trailing semicolons
- No comments unless WHY is non-obvious
- No dead code or commented blocks
- All costs in USD internally, converted at display time
- CSV export sanitizes formula-injection characters (`=`, `+`, `-`, `@`)
