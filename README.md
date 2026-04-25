![CodeBurn](https://cdn.jsdelivr.net/gh/getagentseal/codeburn@main/assets/logo.png)

# CodeBurn

See where your Auggie credits and token estimates go.

A usage analytics tool for [Augment Code (Auggie)](https://www.augmentcode.com/) CLI sessions. Reads `~/.augment/sessions/*.json` directly from disk and surfaces Augment credits, token-pricing estimates, tools, shell commands, MCP servers, models, and per-project usage in an interactive terminal dashboard. No wrapper, no proxy, no API keys.

![node version](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![license](https://img.shields.io/npm/l/codeburn.svg)

![CodeBurn TUI dashboard](https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/dashboard.jpg)

*Screenshot predates 2.0.0 and will be updated.*

## Project status

- **Version:** 2.0.1 (Auggie-only, CLI-only fork)
- **Tests:** Vitest suite, build, typecheck, `./run.sh --check`, and `git diff --check` used for readiness verification
- **What's new in 2.0.1:** Removed macOS menubar app (CLI-only fork), added GPT-5.2 pricing. See [CHANGELOG.md](./CHANGELOG.md) for details.

## Prerequisites

CodeBurn reads local files only. To get useful output you need:

- **Node.js ≥ 22** (see `engines` in [`package.json`](./package.json)).
- **Auggie (Augment Code CLI) installed and logged in.** Running `auggie login` creates session files that CodeBurn reads.
- **Session history under `~/.augment/sessions/`.** Every Auggie conversation is saved there as a pretty-printed JSON file. If the directory is empty or missing, the dashboard will have nothing to show.

Override the Augment directory with `AUGMENT_HOME=/path/to/.augment` if you keep it elsewhere.

## Install

This fork is Auggie-specific and runs from source. Clone, build, then either invoke directly or link it into `$PATH`:

### Quickstart (one command)

```bash
git clone https://github.com/jaycdave88/codeburn.git
cd codeburn
./run.sh
```

`run.sh` checks prerequisites, builds if needed, and launches the dashboard in credits mode. See [Quick mode switch via `run.sh`](#quick-mode-switch-via-runsh) below to change modes.

### Manual build

```bash
git clone https://github.com/jaycdave88/codeburn.git
cd codeburn
npm install
npm run build

# Option A: invoke directly
node dist/cli.js                         # interactive TUI
node dist/cli.js --format json           # machine-readable report
node dist/cli.js export --format json    # full CSV/JSON export

# Option B: link globally (gives you `codeburn …` in your shell)
npm link
codeburn                                 # now works anywhere
```

During development, `npm run dev -- report` runs the CLI directly via `tsx` without a build step.

> **Note:** The upstream `codeburn` package on npm (v1.x) is a different build. Running `npm install -g codeburn` or `npx codeburn` installs the upstream package, **not this fork**.

## Usage

> For the fastest path, see [`./run.sh`](#quickstart-one-command) above. The examples below use the `codeburn` binary after `npm link`, or `node dist/cli.js` otherwise.

> **Note:** If you ran `npm link`, you can use `codeburn …` below. Otherwise substitute `node dist/cli.js …`.

```bash
codeburn                       # interactive dashboard (default: 7 days)
codeburn today                 # today's usage
codeburn month                 # this month's usage
codeburn report -p 30days      # rolling 30-day window
codeburn report -p all         # every recorded session
codeburn report --from 2026-04-01 --to 2026-04-10
codeburn report --format json  # full dashboard data as JSON
codeburn status                # compact one-liner (today + month)
codeburn export                # per-period CSV bundle
codeburn export -f json        # JSON export
codeburn optimize              # find waste, get copy-paste fixes
codeburn currency GBP          # switch display currency (any ISO 4217 code)
```

Arrow keys switch between Today / 7 Days / 30 Days / Month / All Time. Press `q` to quit, `1`–`5` for shortcuts, `o` to open optimize findings inline.

`--project <name>` and `--exclude <name>` (both repeatable, case-insensitive substring match) filter by project on every command. `--from` / `--to` (`YYYY-MM-DD`, local time) set an exact window; either flag alone is valid.

## What the dashboard shows

| Panel | What it contains |
|---|---|
| **Overview** | In **credits mode**: shows Augment credits as the primary usage metric plus token totals; the legacy `cost` field is `null` and any USD/token value is labeled as an estimate. In **token_plus (USD-estimate) mode**: shows base cost, surcharge, and billed USD estimates; credits are `null`. Both modes show total calls, sessions, cache-hit %, and legacy-session count when applicable. |
| **By Model** | Per-model breakdown. In credits mode: credits column. In token_plus mode: base/surcharge/billed USD columns. Pre-Nov-2025 sessions appear under `auggie-legacy`; set-but-unpriced non-empty model IDs stay visible as raw IDs with `pricingStatus=unpriced` warnings so you can diagnose unknown pricing. |
| **Daily Activity** | Sparkline of the active billing metric (credits or billed USD estimate) per local day across the selected window |
| **Projects** | Top projects by the active billing metric, with project/workspace labels propagated from Auggie session metadata when available |
| **Activities** | Auggie-native tool/activity categories (View/Read, Terminal, Search/Retrieval, File Write/Edit, Browser, Agent/Workspace, …). These are usage categories, not billing-rate multipliers. |
| **Core Tools** | Non-shell, non-MCP tool invocations aggregated at the exchange level (so counts don't double from multi-node exchanges) |
| **Shell Commands** | `launch-process` command lines pulled from every tool-use node |
| **MCP Servers** | MCP tool calls routed by `tool_use.mcp_server_name` when present, suffix-parsed as fallback for older sessions |

The `--format json` flag on `report`, `today`, `month`, and `status`, plus `export --format json`, emits machine-readable data. Treat JSON and CSV as **semi-stable customer-facing APIs**: fields may be added, but billing fields are labeled to distinguish authoritative local credits from estimates. Current report/status/export payloads include top-level `schema` and `schemaVersion` fields (`codeburn.report.v2`, `codeburn.status.v2`, `codeburn.export.v2`; `schemaVersion: 2`), a top-level `billing` block, and per-row fields such as `creditsAugment`, `creditsSynthesizedCalls`, `subAgentCreditsUsedUnconfirmed`, `pricingStatus`, `warnings`, `costEstimateUsd`, `baseCostUsd`, `surchargeUsd`, and `billedAmountUsd`.

## How Auggie sessions are parsed

Auggie writes one JSON file per conversation into `~/.augment/sessions/`. CodeBurn walks each file's `response_node` stream, aggregates at the **exchange level** (tool_use nodes + token_usage nodes that belong to the same model turn), and emits one row per `token_usage` node. Dedup key: `auggie:${sessionId}:${request_id}:${response_node.id}`. Sub-agent sessions are tagged with their `rootTaskUuid` in the session label.

**Model selection** prefers `agentState.modelId`; non-empty IDs remain visible as raw IDs unless you explicitly set `CODEBURN_AUGGIE_ALIAS_<MODELID>`. When CodeBurn cannot price a raw ID, it marks `pricingStatus=unpriced`, emits warnings in JSON/export/status output, and omits that usage from synthesized USD/credit estimates. When `modelId` is empty, CodeBurn falls back to a provider-aware parser default derived from `metadata.provider` on type-8 THINKING nodes (see `CODEBURN_AUGGIE_DEFAULT_*` in the Environment Variables table below). These defaults are parser fallbacks for missing local metadata, not a statement of your organization's Augment default model. Sessions with neither a `modelId` nor a recoverable provider hint (pre-Nov-2025 sessions) bucket under `auggie-legacy`.

**Credits** are best-effort local billing numbers from Auggie session JSON. When numeric `session.creditUsage` is present, CodeBurn treats it as the authoritative local session total and prefers it over recomputing from type-9 `billing_metadata`. Otherwise, CodeBurn sums `billing_metadata.credits_consumed` on type-9 BILLING_METADATA nodes, deduped by `transaction_id`. When neither source is present and model pricing is known, synthesized credits are an estimate. `subAgentCreditsUsed` is currently informational/unconfirmed: do not add it to totals or assume it is included in `creditUsage` until Augment confirms the upstream semantics. In **token_plus mode**, USD cost is computed from token counts using [LiteLLM](https://github.com/BerriAI/litellm) pricing (cached at `~/.cache/codeburn/litellm-pricing.json`); in **credits mode** the legacy USD `cost` field is `null` and `costEstimateUsd` is only a secondary token-pricing estimate.

Parsed calls are cached per session at `~/.cache/codeburn/auggie/<id>.json` (mode `0600`) and invalidated on mtime+size change. The credentials file at `~/.augment/session.json` is never read by the CLI.

## Environment variables

| Variable | Description |
|---|---|
| `AUGMENT_HOME` | Override the Augment data directory (default: `~/.augment`). |
| `CODEBURN_BILLING_MODE` | `credits` or `token_plus` (default: `credits`). See [Billing modes](#billing-modes) for details. |
| `CODEBURN_SURCHARGE_RATE` | Decimal surcharge for token_plus mode (default: `0`). See [Billing modes](#billing-modes) for details. |
| `CODEBURN_AUGGIE_DEFAULT_ANTHROPIC` | Fallback model when `modelId` is empty and `metadata.provider = anthropic` (default: `claude-sonnet-4-5`). |
| `CODEBURN_AUGGIE_DEFAULT_OPENAI` | Fallback model for OpenAI (default: `gpt-5.1`). |
| `CODEBURN_AUGGIE_DEFAULT_GEMINI` | Fallback model for Gemini (default: `gemini-3-pro`). |
| `CODEBURN_AUGGIE_DEFAULT_XAI` | Fallback model for xAI (default: `grok-2`). |
| `CODEBURN_AUGGIE_DEFAULT_MINIMAX` | Fallback model for MiniMax (default: `minimax`). |
| `CODEBURN_AUGGIE_ALIAS_<MODELID>` | Optional local alias for a specific Augment-internal model ID after you have verified the mapping. Example: `CODEBURN_AUGGIE_ALIAS_BUTLER=claude-haiku-4-5`. |
| `CODEBURN_VERBOSE` | Set to `1` to enable verbose logging (same as `--verbose` flag). Prints warnings to stderr on skipped/failed session reads. |
| `CODEBURN_CACHE_DIR` | Override the cache directory (default: `~/.cache/codeburn`). Affects session cache, daily cache, pricing cache, and FX rate cache. |
| `BASH_MAX_OUTPUT_LENGTH` | Cap shell command output length in bytes (no default). Prevents unbounded token consumption from long-running commands. |

## Currency

```bash
codeburn currency GBP          # any ISO 4217 code (162 currencies supported)
codeburn currency              # show current setting
codeburn currency --reset      # back to USD
```

Rates come from [Frankfurter](https://www.frankfurter.app/) (ECB data, no API key) and are cached for 24 hours. Config lives at `~/.config/codeburn/config.json` and applies to dashboard, exports, and JSON output.

## Optimize

```bash
codeburn optimize              # scan last 30 days, print copy-paste fixes
codeburn optimize -p week      # last 7 days
```

Detects files re-read across sessions, low Read:Edit ratios, uncapped bash output, cache-creation overhead, and junk directory reads. Each finding shows estimated token and dollar savings plus a ready-to-paste fix, rolled up into an A-F setup health grade. Repeat runs classify findings as new / improving / resolved against a 48-hour window. Press `o` in the dashboard to open findings inline, `b` to return.

![CodeBurn optimize output](https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/optimize.jpg)

*Screenshot predates 2.0.0 and will be updated.*

## Billing modes

CodeBurn supports two billing modes for tracking Auggie usage. Neither mode promises invoice-grade accounting; use Augment's official ledger/invoice for billing reconciliation.

### `credits` (default)

Shows **Augment credits** consumed per session and per model. Credits are the primary customer-facing metric in CodeBurn.

- **Authoritative local credits**: numeric `session.creditUsage` wins when present.
- **Billing metadata fallback**: when `creditUsage` is absent, CodeBurn dedupes and sums type-9 `billing_metadata.credits_consumed` values by `transaction_id`.
- **Synthesized credits**: when no local credit source exists but token pricing is known, credits are estimated as `⌈ base_cost_usd × 1600 ⌉`. The `1600` multiplier is CodeBurn's current implementation default, not a contract-grade tenant invariant.
- **Sub-agent credits**: `subAgentCreditsUsed` is shown only as informational/unconfirmed data when surfaced; it is not added to totals until upstream semantics are confirmed.

### `token_plus` (a.k.a. "USD estimate")

Shows estimated **USD cost** instead of credits. Use this when you want a token-pricing view or have a separate contracted USD surcharge to model.

- Displays `base cost`, `surcharge`, and `billed amount` columns
- Formula: `billed = base_cost_usd × (1 + surcharge_rate)`
- Values are derived from local token counts plus LiteLLM pricing and are secondary to Augment credits.

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `CODEBURN_BILLING_MODE` | `credits` or `token_plus` | `credits` |
| `CODEBURN_SURCHARGE_RATE` | Decimal surcharge for token_plus mode | `0` (0% surcharge; enterprise USD users set to contracted rate e.g. `0.3` for 30%) |

### Quick mode switch via `run.sh`

```bash
./run.sh                                          # credits mode (default)
BILLING_MODE=token_plus ./run.sh                  # USD estimate, 0% surcharge
BILLING_MODE=token_plus SURCHARGE_RATE=0.3 ./run.sh  # Enterprise USD, 30% surcharge
FORMAT=json ./run.sh | jq '.billing'              # JSON output, pipe to jq
./run.sh --check                                  # 5-point UI/UX sanity pass
```

The top of `run.sh` has commented placeholders you can edit in-place if you'd rather not use inline env vars.

### CLI examples

```bash
# Default — credits mode (if you ran `npm link`, use `codeburn today` instead)
node dist/cli.js today

# USD-estimate mode, default 0% surcharge
CODEBURN_BILLING_MODE=token_plus node dist/cli.js today

# Enterprise USD with contracted 30% surcharge
CODEBURN_BILLING_MODE=token_plus CODEBURN_SURCHARGE_RATE=0.3 node dist/cli.js today
```

### Limitations

> **⚠️ Billing numbers are local best-effort analytics.** CodeBurn reads local Auggie session JSON, not Augment's invoice system. Numeric `creditUsage` is treated as authoritative for local session usage when present, but totals may still differ from invoices because tenant policy, upstream billing adjustments, and server-side metering are outside the local files.

- Token+ USD values and `costEstimateUsd` are token-pricing estimates, not authoritative Augment credit billing.
- The `CREDITS_PER_DOLLAR = 1600` multiplier is an implementation default used only for estimates when local credit data is missing; do not treat it as a contractual rate.
- Activity rows categorize work by observed Auggie tool/session usage. They are not billing-rate multipliers; CodeBurn keeps activity multiplier assumptions at `1.0` until authoritative values exist.
- Unknown/unpriced non-empty model IDs remain visible as raw IDs with pricing unknown. They do not contribute to authoritative credit totals unless a local credit source exists; token_plus/base/cost estimate fields are `null` when pricing is unavailable.
- Legacy sessions missing both `modelId` and a recoverable provider hint are reported under `auggie-legacy` with `null` credits/cost unless local credit data exists.
- Nonzero `subAgentCreditsUsed` semantics are not confirmed. Treat the field as informational and avoid adding it to totals manually, to prevent double counting.

### Machine-readable field notes

JSON/CSV outputs are semi-stable APIs. Current billing-related fields include:

- `billing.mode`: `credits` or `token_plus`.
- `billing.amountFields`: machine-readable descriptions of which amount fields are authoritative or estimated in the active mode.
- `cost`: legacy compatibility field. It is `null` in credits mode and aliases `billedAmountUsd` in token_plus mode.
- `creditsAugment`: Augment credits when available locally, or synthesized credits when marked by `creditsSynthesizedCalls`.
- `creditsSynthesizedCalls`: number of calls whose credits were estimated from token pricing because local credit data was unavailable.
- `subAgentCreditsUsedUnconfirmed`: nonzero Auggie `subAgentCreditsUsed` surfaced separately as informational/unconfirmed data. It is not included in credit totals.
- `pricingStatus` and `warnings`: per-model markers for unpriced raw model IDs; warnings are also surfaced at report/status/export overview level.
- `costEstimateUsd`: secondary token-pricing estimate in credits mode.
- `baseCostUsd`, `surchargeUsd`, `billedAmountUsd`: token_plus USD estimate fields.
- CSV exports label the same informational data as `Sub-Agent Credits (Unconfirmed)`.
- `schema` and `schemaVersion`: present on report/status/export JSON (`codeburn.report.v2`, `codeburn.status.v2`, `codeburn.export.v2`; `schemaVersion: 2`). Fields may be added within the same major schema; incompatible machine-readable changes require a new schema string/version.

### Rate-card reference

The credit pricing table is cross-referenced against [docs.augmentcode.com/models/credit-based-pricing](https://docs.augmentcode.com/models/credit-based-pricing) (advisory, checked 2026-04-25). Augment's internal billing configuration and your tenant policy remain the source of truth.

**Public Augment credit reference:**

| Model | Relative to Sonnet | Notes |
|---|---|---|
| Claude Sonnet 4.5/4.6 | 100% (baseline) | 293 credits per standard task |
| Claude Opus 4.5/4.6/4.7 | 167% | 488 credits per standard task |
| Claude Haiku 4.5 | 30% | 88 credits per standard task |
| Gemini 3.1 Pro | 92% | 268 credits per standard task |
| GPT-5.1 | 75% | 219 credits per standard task |
| GPT-5.2 | 133% | 390 credits per standard task |
| GPT-5.4 | 72% | 210 credits per standard task |
| GPT-5.5 | 143% | 420 credits per standard task |

Models in CodeBurn's local token-pricing table that aren't on the public credit page are token-cost fallbacks, not authoritative credit-rate entries: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1*`, `gpt-5`, `gpt-5-mini`, `gpt-5.3-codex`, `gpt-5.4-mini`, `o3`, `o4-mini`, `claude-3-5-sonnet`, `claude-3-7-sonnet`, `claude-3-5-haiku`, `gemini-2.5-pro`, `auggie-legacy`, and any raw unpriced Auggie model IDs that appear in local sessions.

GPT-5.2 is included in `models.ts` (added in v2.0.1). GPT-5.5 public credit pricing is documented above; only use internal Auggie aliases for GPT-5.5 after they are confirmed in code.

## Data and privacy

CodeBurn reads Auggie session history from local JSON files under `~/.augment/sessions/` (or `AUGMENT_HOME/sessions`). Session parsing, grouping, billing aggregation, CSV generation, and JSON export all happen on your machine. CodeBurn does **not** upload prompts, responses, tool inputs, session JSON, or billing data to a CodeBurn service.

The network calls CodeBurn makes are limited to public metadata refreshes:

| Caller | Endpoint | Payload | When |
|---|---|---|---|
| CLI | `raw.githubusercontent.com/BerriAI/litellm/...` | none (GET) | LiteLLM model-price refresh (cached at `~/.cache/codeburn/litellm-pricing.json`) |
| CLI | `api.frankfurter.app` | none (GET) | currency FX rate refresh (cached 24h) |

Cache and config files are created with mode `0600` under directories with mode `0700`. The Augment credentials file at `~/.augment/session.json` is explicitly skipped and never parsed.

## Troubleshooting

- **`By Model` shows `auggie-legacy`** — these are pre-Nov-2025 sessions with an empty `modelId` and no recoverable provider hint. The model is unrecoverable; the Overview panel shows a parenthetical hint (`(N legacy sessions — model unrecoverable)`) so you can see the blind-spot size. This is expected.
- **Credits column shows `—`** — the session has no numeric `creditUsage`, no type-9 `billing_metadata` credits, and no safe synthesized-credit estimate. Typical for very old sessions, CLI-offline runs, or unknown/unpriced models.
- **Core Tools / Shell Commands / MCP Servers tables empty** — confirm `~/.augment/sessions/` contains recent files (`ls -lt ~/.augment/sessions/ | head`). If your Augment data lives elsewhere, set `AUGMENT_HOME`.
- **Raw model ID with `pricingStatus=unpriced` in By Model** — CodeBurn found a non-empty Auggie `modelId` that has no confirmed pricing/alias. The raw ID is intentionally preserved for diagnosability, and synthesized USD/credit estimates omit that usage. Add an alias via `CODEBURN_AUGGIE_ALIAS_<MODELID>=<public-model-name>` only when you are confident about the mapping, or file an issue.

## Development

```bash
npm install
npm test                       # vitest tests
npm run build                  # tsup → dist/cli.js (target: node20¹)
npx tsc --noEmit               # typecheck source without writing dist
./run.sh --check               # readiness smoke check for JSON/billing modes
git diff --check               # whitespace check before opening a PR

¹ `tsup.config.ts` uses `target: node20` for compile-time syntax transpilation, while `package.json engines` requires Node ≥ 22 at runtime.
npm run dev -- report          # run CLI directly from src/ via tsx
```

Full version history is in [CHANGELOG.md](./CHANGELOG.md). Historical security and quality findings are in [AUDIT_REPORT.md](./AUDIT_REPORT.md); that report is a 1.0.0 snapshot and is not the current readiness source of truth.

## Project structure

```
src/
  cli.ts              Commander.js entry point
  dashboard.tsx       Ink TUI (React for terminals)
  parser.ts           Session reader, dedup, date filter, MCP extraction
  models.ts           LiteLLM pricing, cost calculation
  classifier.ts       Auggie-native activity classifier
  format.ts           Text rendering (cost, tokens, credits)
  export.ts           CSV/JSON multi-period export
  config.ts           Config file management (~/.config/codeburn/)
  currency.ts         Currency conversion, Intl formatting
  optimize.ts         Waste-pattern scanner
  providers/
    index.ts          Provider registry (single entry: auggie)
    auggie.ts         Session discovery, exchange-level parsing, credits, model selection
tests/                Vitest suite (providers, security, parser, export, …)
```

## License

MIT

## Credits

Inspired by [ccusage](https://github.com/ryoppippi/ccusage). Pricing from [LiteLLM](https://github.com/BerriAI/litellm). Exchange rates from [Frankfurter](https://www.frankfurter.app/). Built by [AgentSeal](https://agentseal.org).
