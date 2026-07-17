# CodeBurn Architecture

A map of the codebase. Read this once before opening a non-trivial PR.

## Three Surfaces

CodeBurn is one Node.js CLI plus two GUI clients that shell out to it.

```
+----------------------+      +-----------------+
| mac/  (Swift)        | ---> |                 |
+----------------------+      |  src/cli.ts     |
| gnome/ (JavaScript)  | ---> |  (the CLI)      |
+----------------------+      |                 |
                              |  status         |
                              |  --format       |
                              |  menubar-json   |
                              +-----------------+
                                       |
                                       v
                          +----------------------------+
                          | session files on disk      |
                          | (JSONL, SQLite, protobuf)  |
                          +----------------------------+
```

The macOS menubar (`mac/`) and the GNOME extension (`gnome/`) both invoke `codeburn status --format menubar-json --period <p>` and parse the JSON. They do not share code with the CLI; they only depend on its output contract.

## CLI (`src/`)

`src/cli.ts` is the Commander.js entry point. The bin field in `package.json` points at `dist/cli.js`. Twelve commands are registered:

| Command | Line | Purpose |
|---|---|---|
| `report` | 274 | Default. Interactive Ink TUI dashboard. |
| `status` | 358 | Compact text status, plus `--format menubar-json` for clients. |
| `today` | 524 | Today-only view of `report`. |
| `month` | 542 | Month-only view of `report`. |
| `export` | 560 | CSV or JSON dump of usage data. |
| `menubar` | 621 | Downloads and launches the macOS menubar bundle. |
| `currency` | 636 | Sets display currency. |
| `model-alias` | 687 | Maps an unknown model name to a known one for pricing. |
| `plan` | 737 | Configures a subscription plan for overage tracking. |
| `optimize` | 857 | Runs all 14 waste detectors. |
| `compare` | 870 | Compares two models side by side. |
| `yield` | 882 | Tracks which sessions shipped to main vs. were reverted (experimental). |

### Pipeline

```
provider.discoverSessions()
        |
        v
provider.createSessionParser(source, seenKeys)
        |
        v   yields ParsedProviderCall (see src/providers/types.ts)
        |
        v
src/parser.ts: parseAllSessions()
        |
        v   aggregates into ProjectSummary[]
        |
        v
src/daily-cache.ts: aggregate per day, persist
        |
        v
output formatter (Ink TUI, JSON, or menubar-json)
```

`src/parser.ts` is the central aggregator. Public exports: `parseAllSessions`, `filterProjectsByName`, `extractMcpInventory`. It owns the dedup `Set` (`seenKeys`) that is passed into every provider parser so a turn that surfaces in two providers (Claude logs vs. Cursor mirror, for instance) is counted once.

### Cache Layers

Three caches under `~/.cache/codeburn/` (override with `CODEBURN_CACHE_DIR`):

| File | Owner | Invalidation |
|---|---|---|
| `codex-results.json` | `src/codex-cache.ts` | `mtimeMs + sizeBytes` per Codex `.jsonl`. |
| `cursor-results.json` | `src/cursor-cache.ts` | `mtimeMs + sizeBytes` of the Cursor SQLite db. |
| `daily-cache.json` | `src/daily-cache.ts` | Tracks `lastComputedDate`; new days are backfilled, old days are reused. |

All three use atomic write (temp file + `rename`) and write with mode `0o600`. All three carry a numeric `version` field; bumping it forces a recompute next run.

### Optimize Detectors

`src/optimize.ts` exports 14 detectors. Each returns a `WasteFinding | null`. They are composed by `runOptimize()` which collects findings, ranks them by impact, and returns them with `WasteAction` objects (paste-to-CLAUDE.md, paste-to-session-opener, prompt-now, edit shell config).

| Detector | Line | What it catches |
|---|---|---|
| `detectJunkReads` | 428 | Reads into `node_modules`, `.git`, `dist`, etc. |
| `detectDuplicateReads` | 477 | Re-reads of the same file in a session. |
| `detectMcpToolCoverage` | 795 | MCP servers with many tools but low usage. |
| `detectUnusedMcp` | 855 | MCP servers configured but never invoked. |
| `detectBloatedClaudeMd` | 944 | `CLAUDE.md` files past a healthy size. |
| `detectLowReadEditRatio` | 987 | Edit-heavy sessions with too few prior reads. |
| `detectCacheBloat` | 1048 | High `cache_creation_input_tokens`. |
| `detectGhostAgents` | 1124 | Defined but never-invoked Claude agents. |
| `detectGhostSkills` | 1154 | Defined but never-invoked skills. |
| `detectGhostCommands` | 1184 | Defined but never-invoked slash commands. |
| `detectBashBloat` | 1228 | Shell output limit set above the recommended 15K chars. |
| `detectLowWorthSessions` | 1405 | Sessions with cost but no edits or git delivery. |
| `detectContextBloat` | 1512 | Input:output token ratio above 25:1. |
| `detectSessionOutliers` | 1558 | Sessions costing more than 2x the project average. |

### Output Formats

| Command | `--format` choices | Default |
|---|---|---|
| `report`, `today`, `month` | `tui`, `json` | `tui` |
| `status` | `terminal`, `menubar-json`, `json` | `terminal` |
| `export` | `csv`, `json` | `csv` |
| `plan` | `text`, `json` | `text` |

The macOS menubar and GNOME extension consume `menubar-json`. `src/menubar-json.ts` defines the contract; `tests/menubar-json.test.ts` pins it.

## Providers (`src/providers/`)

Every provider implements the `Provider` interface in `src/providers/types.ts`:

```ts
type Provider = {
  name: string
  displayName: string
  modelDisplayName(model: string): string
  toolDisplayName(rawTool: string): string
  discoverSessions(): Promise<SessionSource[]>
  createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser
}
```

`src/providers/index.ts` registers providers across two tiers:

- **Eager**: `claude`, `cline`, `codewhale`, `codebuff`, `codex`, `copilot`, `devin`, `droid`, `gemini`, `hermes`, `ibm-bob`, `kilo-code`, `kiro`, `kimi`, `lingtai-tui`, `mistral-vibe`, `mux`, `openclaw`, `open-design`, `pi`, `omp`, `qwen`, `roo-code`, `zerostack`, `grok`. Imported at module load.
- **Lazy**: `antigravity`, `forge`, `goose`, `cursor`, `opencode`, `cursor-agent`, `crush`, `warp`, `vercel-gateway`, `zcode`, `zed`. Imported via dynamic `import()` so the heavy dependencies (SQLite, protobuf, network clients) do not touch users who do not have those tools installed.

Both lists hit the same `getAllProviders()` aggregator. A failed lazy import is silent and excludes that provider from the run.

`src/providers/vscode-cline-parser.ts` is a shared helper consumed by `cline`, `ibm-bob`, `kilo-code`, and `roo-code`. It is not registered as a provider on its own.

For the per-provider data location, storage format, parser quirks, and test coverage, see `docs/providers/`.

## macOS Menubar (`mac/`)

Swift package (`mac/Package.swift`), targets macOS 14, strict concurrency on. Layout under `mac/Sources/CodeBurnMenubar/`:

- `CodeBurnApp.swift` boots the SwiftUI `App` and the `NSStatusItem`.
- `AppStore.swift` is the single source of truth for UI state.
- `Data/` holds models, the CLI client, credential stores, and subscription services.
  - `DataClient.swift` spawns the CLI and decodes `MenubarPayload`. See file-level comment for why we never route through `/bin/zsh -c`.
  - `MenubarPayload.swift` mirrors the JSON the CLI emits; keep it in sync with `src/menubar-json.ts`.
- `Security/CodeburnCLI.swift` resolves the CLI binary (env override `CODEBURN_BIN`, fallback `codeburn`), validates each argv entry against an allowlist regex, and augments PATH for Homebrew and npm-global installs. The Process is launched via `/usr/bin/env`, never via a shell.
- `Theme/` holds color and typography constants and the dark/light state.
- `Views/` are the SwiftUI components rendered inside `NSPopover`.

Tests live in `mac/Tests/CodeBurnMenubarTests/` (currently `CapacityEstimatorTests.swift`).

The build artifact is a zipped `.app` bundle produced by `mac/Scripts/package-app.sh`. See `RELEASING.md` for how the GitHub Actions workflow uses it.

## GNOME Extension (`gnome/`)

Plain JavaScript, no bundler. Targets GNOME Shell 45-50 (`metadata.json`).

- `extension.js` is the entry point. On `enable()` it constructs a `CodeBurnIndicator` and adds it to the panel.
- `indicator.js` is the popover. It owns the period selector, the insight tabs, and the provider filter.
- `dataClient.js` wraps `Gio.Subprocess` to call the CLI. It validates argv against the same allowlist pattern as the macOS client and augments PATH with `~/.local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin`, `~/.cargo/bin`, `~/.asdf/shims`, and a few others. Results are cached for 300 seconds.
- `prefs.js` is the settings dialog backed by `schemas/org.gnome.shell.extensions.codeburn.gschema.xml`.
- `install.sh` copies the extension into `~/.local/share/gnome-shell/extensions/`.

## Build (`scripts/`, `tsup.config.ts`)

`npm run build` is two steps:

1. `node scripts/bundle-litellm.mjs` fetches the latest litellm pricing JSON and writes `src/data/litellm-snapshot.json`. The bundle script keeps a manual override for MiniMax variants. Direct (un-prefixed) entries win over prefixed ones. The result is checked in so the build is reproducible.
2. `tsup` reads `tsup.config.ts` and emits a single ESM bundle at `dist/cli.js` with a Node shebang banner. No source maps in publish builds; sourcemaps on for development.

The `prepublishOnly` hook in `package.json` runs `npm run build` so `npm publish` always ships fresh code.

## Tests

`npm test` runs vitest. Forty-two test files live under `tests/`:

- `tests/` root (27 files) covers CLI, parser, optimize, cache, format, models, plans.
- `tests/security/` (1 file) covers prototype-pollution guards.
- `tests/providers/` (15 files) covers per-provider parsing.
- `tests/fixtures/` holds redacted real-world session data.

Five providers ship without dedicated test files today: `antigravity`, `claude`, `gemini`, `goose`, `qwen`. Closing this gap is a standing good-first-issue.

CI runs Semgrep against `.semgrep/rules/no-bracket-assign-hot-paths.yml` over `src/providers/` and `src/parser.ts` (`.github/workflows/ci.yml`). It does not run vitest in CI today; tests run locally before publish.
