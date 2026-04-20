![CodeBurn](https://cdn.jsdelivr.net/gh/getagentseal/codeburn@main/assets/logo.png)

# CodeBurn

See where your Auggie tokens (and credits) go.

A usage analytics tool for [Augment Code (Auggie)](https://www.augmentcode.com/) CLI sessions. Reads `~/.augment/sessions/*.json` directly from disk and surfaces cost, Augment credits, tools, shell commands, MCP servers, models, and per-project spend in an interactive terminal dashboard. No wrapper, no proxy, no API keys.

![node version](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![license](https://img.shields.io/npm/l/codeburn.svg)

![CodeBurn TUI dashboard](https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/dashboard.jpg)

*Screenshot predates 2.0.0 and will be updated.*

## Project status

- **Version:** 2.0.1 (Auggie-only, CLI-only fork)
- **Tests:** 160+ passing
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
| **Overview** | In **credits mode**: shows Augment credits (ground-truth and synthesized) plus token totals; USD fields are `null`. In **token_plus (USD-estimate) mode**: shows base cost, surcharge, and billed USD; credits are `null`. Both modes show total calls, sessions, cache-hit %, and legacy-session count when applicable. |
| **By Model** | Per-model breakdown. In credits mode: credits column. In token_plus mode: base/surcharge/billed USD columns. Pre-Nov-2025 sessions appear under `auggie-legacy`; set-but-unpriced IDs under `auggie-unknown`. |
| **Daily Activity** | Sparkline of cost per day across the selected window |
| **Projects** | Top projects by cost, with `avgCostPerSession` in JSON output |
| **Activities** | 13 deterministic task categories (Coding, Debugging, Refactoring, Testing, …) with one-shot success rate |
| **Core Tools** | Non-shell, non-MCP tool invocations aggregated at the exchange level (so counts don't double from multi-node exchanges) |
| **Shell Commands** | `launch-process` command lines pulled from every tool-use node |
| **MCP Servers** | MCP tool calls routed by `tool_use.mcp_server_name` when present, suffix-parsed as fallback for older sessions |

The `--format json` flag on `report`, `today`, and `month` emits a structured payload. In v2+, output includes a top-level `billing` block (`mode`, `creditsPerDollar`, `surchargeRate`, `activityMultiplier`) and per-row fields: `creditsAugment`, `creditsSynthesized`, `baseCostUsd`, `surchargeUsd`, `billedAmountUsd`. Pipe to `jq` for filtering.

## How Auggie sessions are parsed

Auggie writes one JSON file per conversation into `~/.augment/sessions/`. CodeBurn walks each file's `response_node` stream, aggregates at the **exchange level** (tool_use nodes + token_usage nodes that belong to the same model turn), and emits one row per `token_usage` node. Dedup key: `auggie:${sessionId}:${request_id}:${response_node.id}`. Sub-agent sessions are tagged with their `rootTaskUuid` in the session label.

**Model selection** prefers `agentState.modelId` (resolved through an alias table). When it's empty, CodeBurn falls back to a provider-aware default derived from `metadata.provider` on type-8 THINKING nodes (see `CODEBURN_AUGGIE_DEFAULT_*` and `CODEBURN_AUGGIE_ALIAS_*` in the Environment Variables table below). Sessions with neither a `modelId` nor a recoverable provider hint (pre-Nov-2025 sessions) bucket under `auggie-legacy`; `auggie-unknown` is reserved for sessions where the `modelId` is set but not yet in the alias table.

**Credits** come from Augment's own billing metadata: `billing_metadata.credits_consumed` on type-9 BILLING_METADATA nodes, deduped by `transaction_id`. When the top-level `session.creditUsage` is present it's used as the authoritative session total (it already includes sub-agent credits). In **token_plus mode**, USD cost is computed from token counts using [LiteLLM](https://github.com/BerriAI/litellm) pricing (cached at `~/.cache/codeburn/litellm-pricing.json`); in **credits mode** the USD column is `null`.

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
| `CODEBURN_AUGGIE_ALIAS_<MODELID>` | Override the alias for a specific Augment-internal model ID. Example: `CODEBURN_AUGGIE_ALIAS_BUTLER=claude-haiku-4-5`. |
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

CodeBurn supports two billing modes for tracking Auggie usage:

### `credits` (default)

Shows **Augment credits** consumed per session and per model. Credits are the authoritative billing unit for most users.

- **Ground-truth credits**: When present in session data (via `billing_metadata.credits_consumed`), these are used directly
- **Synthesized credits**: When ground-truth is missing but model pricing is known, credits are computed as `⌈ base_cost_usd × 1600 ⌉`

### `token_plus` (a.k.a. "USD estimate")

Shows estimated **USD cost** instead of credits. Useful for enterprise users with contracted USD rates.

- Displays `base cost`, `surcharge`, and `billed amount` columns
- Formula: `billed = base_cost_usd × (1 + surcharge_rate)`

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

> **⚠️ Token+ mode is approximate.** The USD values shown are synthesized from token counts plus a configured surcharge. They are **not invoice-accurate**. True per-request USD (`billed_amount_usd`) lives in Augment's server-side metering pipeline and isn't written to local session logs.

- `CREDITS_PER_DOLLAR = 1600` is the platform default but is a feature flag; some tenants may use a different rate.
- Activity multiplier is hardcoded to 1.0 (correct for `Chat` / `Agent` / `CliNoninteractive`). ContextEngine activities (3.0x) and CodeReview (2.0x) would be under-counted, but these aren't exercised through the Auggie CLI path codeburn reads.
- Legacy sessions missing `modelId` (~22% in observed corpora) are reported as `null` credits / cost.

### Migration from v1.x

JSON schema v2 is **breaking**:
- `overview.cost` is `null` in credits mode (callers that indexed `overview.cost` as a number must handle null)
- New fields: `creditsAugment`, `creditsSynthesized`, `baseCostUsd`, `surchargeUsd`, `billedAmountUsd`, and top-level `billing` block
- Cache format versioned to v2 (pre-v2 caches auto-invalidated on upgrade)

### Rate-card reference

The credit pricing table is cross-referenced against [docs.augmentcode.com/models/credit-based-pricing](https://docs.augmentcode.com/models/credit-based-pricing) (advisory). Internal `billing_configs.jsonnet` is Augment's actual source of truth.

**Models in CodeBurn's pricing table:**

| Model | Relative to Sonnet | Notes |
|---|---|---|
| Claude Sonnet 4.5/4.6 | 100% (baseline) | 293 credits per standard task |
| Claude Opus 4.5/4.6/4.7 | 167% | 488 credits per standard task |
| Claude Haiku 4.5 | 30% | 88 credits per standard task |
| Gemini 3.1 Pro | 92% | 268 credits per standard task |
| GPT-5.1 | 75% | 219 credits per standard task |
| GPT-5.2 | 133% | 390 credits per standard task |
| GPT-5.4 | 143% | 420 credits per standard task |

Models in our table that aren't on the docs page: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1*`, `gpt-5`, `gpt-5-mini`, `gpt-5.3-codex`, `gpt-5.4-mini`, `o3`, `o4-mini`, `claude-3-5-sonnet`, `claude-3-7-sonnet`, `claude-3-5-haiku`, `gemini-2.5-pro`, `auggie-legacy`, `auggie-unknown`.

GPT-5.2 is now included in models.ts (added in v2.0.1).

## Data and privacy

All session parsing is local; no prompt or response text is sent off your machine. The network calls CodeBurn makes are:

| Caller | Endpoint | Payload | When |
|---|---|---|---|
| CLI | `raw.githubusercontent.com/BerriAI/litellm/...` | none (GET) | LiteLLM model-price refresh (cached at `~/.cache/codeburn/litellm-pricing.json`) |
| CLI | `api.frankfurter.app` | none (GET) | currency FX rate refresh (cached 24h) |

Cache and config files are created with mode `0600` under directories with mode `0700`.

## Troubleshooting

- **`By Model` shows `auggie-legacy`** — these are pre-Nov-2025 sessions with an empty `modelId` and no recoverable provider hint. The model is unrecoverable; the Overview panel shows a parenthetical hint (`(N legacy sessions — model unrecoverable)`) so you can see the blind-spot size. This is expected.
- **Credits column shows `—`** — the session has no `billing_metadata` nodes and no top-level `creditUsage`. Typical for very old sessions or CLI-offline runs.
- **Core Tools / Shell Commands / MCP Servers tables empty** — confirm `~/.augment/sessions/` contains recent files (`ls -lt ~/.augment/sessions/ | head`). If your Augment data lives elsewhere, set `AUGMENT_HOME`.
- **`auggie-unknown` in By Model** — CodeBurn has a `modelId` it doesn't know how to price. Add an alias via `CODEBURN_AUGGIE_ALIAS_<MODELID>=<public-model-name>` or file an issue.

## Development

```bash
npm install
npm test                       # vitest tests
npm run build                  # tsup → dist/cli.js (target: node20¹)

¹ `tsup.config.ts` uses `target: node20` for compile-time syntax transpilation, while `package.json engines` requires Node ≥ 22 at runtime.
npm run dev -- report          # run CLI directly from src/ via tsx
```

Full version history is in [CHANGELOG.md](./CHANGELOG.md). Security and quality findings are in [AUDIT_REPORT.md](./AUDIT_REPORT.md).

## Project structure

```
src/
  cli.ts              Commander.js entry point
  dashboard.tsx       Ink TUI (React for terminals)
  parser.ts           Session reader, dedup, date filter, MCP extraction
  models.ts           LiteLLM pricing, cost calculation
  classifier.ts       13-category task classifier
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
