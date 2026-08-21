# CodeBurn Architecture

A map of the codebase. Read this once before opening a non-trivial PR.

## Three Surfaces

CodeBurn is one Node.js CLI plus three ambient GUI clients that shell out to it.

```
+---------------------------+      +-----------------+
| mac/     (Swift)          | ---> |                 |
+---------------------------+      |  src/cli.ts     |
| windows/ (Rust + React)   | ---> |  (the CLI)      |
+---------------------------+      |                 |
| gnome/   (JavaScript)     | ---> |  status         |
+---------------------------+      |  --format       |
                                   |  menubar-json   |
                                   +-----------------+
                                            |
                                            v
                               +----------------------------+
                               | session files on disk      |
                               | (JSONL, SQLite, protobuf)  |
                               +----------------------------+
```

The macOS menubar (`mac/`), the Windows tray app (`windows/`), and the GNOME extension (`gnome/`) all invoke `codeburn status --format menubar-json --period <p>` and parse the JSON. They do not share code with the CLI; they only depend on its output contract.

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

### Parallel Cold Parse

A cold parse spends most of its time on work that is per-file and pure: reading a
session JSONL or a Codex rollout, decoding it, and turning each line into a
journal entry. `src/parse-workers.ts` moves that onto `worker_threads` when the
pending workload is big enough to pay for them. Each worker runs the same
per-file function the serial path runs — `parseClaudeFileFull` for a Claude
session, `parseCodexFileFull` for a Codex rollout — against an empty dedup set,
and ships the result back as a JSON string together with every dedup key it
claimed. The parent installs results in the same order the serial loop would, and
everything with cross-file state (the dedup sets, canonical project paths, spawn
links, PR correlation, the Codex result cache) stays on the main thread. A file
whose keys were already claimed by an earlier file, or whose worker failed, is
re-parsed in-process — so the output is identical to the serial path either way.
That overlap check is what makes a forked Codex rollout safe: it replays its
parent's token_count history under the parent's key namespace, collides, and is
re-parsed against the real dedup set.

A Codex worker never touches `src/codex-cache.ts`: it returns the cache entry it
would have written and the parent writes it, in install order, so
`flushCodexCache` publishes exactly what a serial parse would. Only whole-file
parses go off-thread; the append/incremental paths (a Claude append, a Codex
byte-offset resume) are untouched and stay in-process. The decision is made per
provider — the Claude scan and the provider loop run one after the other, so at
most one pool is alive — and the pool is terminated when its scan ends, so the
resident `serve` child never accumulates threads.

The pool is off by default for anything that is not a large cold parse:

| Gate | Serial when |
|---|---|
| Pending bytes | under 200 MB behind the pending whole-file parses |
| Cores | `availableParallelism() <= 2` |
| Memory | under 4 GB available |

Otherwise the worker count is
`min(cores - 1, min(0.25 * available, 2 GB) / perWorker, max(pendingFiles / 50, pendingBytes / 200 MB))`.
Files and bytes each earn threads on their own, so a few hundred multi-hundred-MB
Codex rollouts parallelize as well as a few thousand small Claude transcripts. The
gate is bytes only, deliberately: 250 pending files holding under a megabyte
between them spawn threads that make the run ~5% slower, and a file count only
starts paying for itself around 400.

`perWorker` is the per-thread memory budget, derived per parse as
`clamp(256 MB, 2 x (pendingBytes / pendingFiles) + 128 MB, 1 GB)`. A flat figure
was wrong in both directions: small Claude transcripts peak well under 256 MB,
while a 260 MB Codex rollout peaks near 430 MB in its worker and scales linearly
with the pool. The budget also covers the parent, which buffers up to `pool.size`
finished results while it installs one.

"Available" is `process.availableMemory()`, falling back to `os.totalmem()`. It is
deliberately not `os.freemem()`: on macOS that counts free pages rather than
available memory and reads as a few hundred MB on an idle 128 GB machine, so a
gate built on it switches the feature on and off between runs. On Linux outside a
memory-limited cgroup, `availableMemory()` reports free memory and can still
under-report on a busy host — which fails safe, to fewer threads or none.

`CODEBURN_PARSE_WORKERS` overrides the decision and skips every gate above:
`0` forces the serial parse, `N` forces N workers (capped at the core count).
`CODEBURN_VERBOSE=1` prints the resolved worker count and the reason for it.

### Cache Layers

Three caches under `~/.cache/codeburn/` (override with `CODEBURN_CACHE_DIR`):

| File | Owner | Invalidation |
|---|---|---|
| `codex-results.v<n>.json` | `src/codex-cache.ts` | `mtimeMs + sizeBytes` per Codex `.jsonl`. Unsuffixed `codex-results.json` is adopted when versions match and never overwritten. |
| `cursor-results.v<n>.json` | `src/cursor-cache.ts` | `mtimeMs + sizeBytes` of the Cursor SQLite db. Unsuffixed `cursor-results.json` is adopted when versions match and never overwritten. |
| `daily-cache.json` | `src/daily-cache.ts` | Tracks `lastComputedDate`; new days are backfilled, old days are reused. |

All three use atomic write (temp file + `rename`) and write with mode `0o600`. All three carry a numeric `version` field; bumping it forces a recompute next run.

The session cache (`src/session-cache.ts`) sits beside them as a directory of per-provider-month shards. A date-ranged query reads only the shards whose months can contribute a turn to that range; `CODEBURN_CACHE_SCOPE=all` turns that off and reads every shard, whatever the range. It is a read policy only — it is not part of any provider's env fingerprint, so setting or unsetting it never invalidates the cache.

### Optimize Detectors

`src/optimize.ts` exports 20 detectors. Each returns a `WasteFinding | null`. They are composed by `runOptimize()` which collects findings, ranks them by impact, and returns them with `WasteAction` objects (paste-to-CLAUDE.md, paste-to-session-opener, prompt-now, edit shell config).

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

- **Eager**: `claude`, `cline`, `codewhale`, `codebuff`, `codex`, `copilot`, `devin`, `droid`, `dsh`, `gemini`, `hermes`, `ibm-bob`, `kilo-code`, `kiro`, `kimi`, `lingtai-tui`, `mistral-vibe`, `mux`, `openclaw`, `open-design`, `pi`, `omp`, `qwen`, `roo-code`, `zerostack`, `grok`. Imported at module load.
- **Lazy**: `antigravity`, `forge`, `goose`, `cursor`, `opencode`, `cursor-agent`, `crush`, `warp`, `vercel-gateway`, `zcode`, `zed`. Imported via dynamic `import()` so the heavy dependencies (SQLite, protobuf, network clients) do not touch users who do not have those tools installed.

Both lists hit the same `getAllProviders()` aggregator. A failed lazy import is silent and excludes that provider from the run.

### WSL roots (Windows)

`src/wsl.ts` is inert off Windows: `wslHomes()` returns `[]` and nothing is spawned. On Windows it runs `%SystemRoot%\System32\wsl.exe --list --quiet --running` (3 s timeout, absolute path so nothing dropped next to the CLI can impersonate it), decodes its UTF-16LE output, keeps only lines shaped like a distro name (single token, no path-banned characters, no trailing period — which discards the "no installed distributions" prose wholesale), drops container-runtime distros, and enumerates `\\wsl$\<distro>\home\*` plus `\\wsl$\<distro>\root`. `\\wsl$\` is probed before `\\wsl.localhost\`: the older spelling works on every build, while probing `wsl.localhost` on a build that lacks it stalls through MUP, SMB and DNS. The result is memoized per process.

`claude` (via `getClaudeConfigDirs`) and `codex` (via `createCodexProvider`) append `<wslHome>/.claude` and `<wslHome>/.codex` to their root lists, so the existing multi-root discovery, `probeRoots()` and `codeburn doctor` cover them with no other changes. Roots are additive — they do not replace `CLAUDE_CONFIG_DIRS`/`CODEX_HOME`.

Two knock-on rules:

- **Running distros only** by default. Touching `\\wsl$\<distro>` boots a stopped distro, which is intrusive and slow. `CODEBURN_WSL=all` opts into every installed distro; `CODEBURN_WSL=off` disables discovery. It is a read policy, never part of a cache fingerprint (see `PROVIDER_ENV_VARS` in `src/session-cache.ts`).
- **Fingerprints drop `dev`/`ino` for `\\wsl$` paths** (`fingerprintFile` in `src/session-cache.ts` and `src/codex-cache.ts`). The 9P share synthesizes them per mount, so keying on them would re-parse every WSL session on every run; mtime+size alone still detects both a modification and an append.
- **A `\\wsl$` cache entry is never evicted for being undiscovered**, and is served even in write mode (`scanProjectDirs` and `parseProviderSources` in `src/parser.ts`). A stopped distro drops its whole root out of discovery; treating that as a deletion would re-parse everything over 9P on the next `wsl` start, and would make totals drop and flicker for the length of a `wsl --shutdown`. The exemption is scoped to `isWslUncPath` — an ordinary path whose file is gone is still evicted.

Session `cwd` values recorded inside WSL are Linux paths (`/home/me/proj`) that name nothing on the Windows filesystem. `resolveCanonicalProjectPath` (`src/parser.ts`) already refuses to walk a path that is not absolute *on the current platform*, so those are attributed to the recorded `cwd` verbatim instead of being walked or canonicalized.

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

## Windows Menubar (`windows/`)

Tauri 2 app: a Rust binary (`windows/src-tauri/`) owning the tray and the process spawning, plus a React + TypeScript popover (`windows/src/`) rendered in a WebView2 window. Design tokens come from `windows/tokens.json`, the same file `mac/` reads at build time, so both products render as one.

- `src-tauri/src/lib.rs` builds the tray, positions the popover against the taskbar edge, and registers the `#[tauri::command]` surface the frontend calls.
- `src-tauri/src/cli.rs` resolves and spawns the CLI. Only absolute `PATH` directories are searched (an empty entry from `;;` would otherwise resolve against the current directory), `CODEBURN_BIN` is allowlisted, and Windows system tools are spawned by absolute `%SystemRoot%\System32` path because `CreateProcess` searches the current directory first. `MIN_CLI_VERSION` gates the whole app; below it the popover shows a setup screen.
- `src-tauri/src/plan.rs` ports the Claude quota view. Like the macOS `ClaudeCredentialStore`, it never spends Claude's single-use refresh token; on a 401 it re-reads Claude's own credential file for a token Claude Code has already rotated.
- `src-tauri/src/tray_badge.rs` renders today's spend into a second tray icon, since Windows has no menubar title.
- `src/App.tsx` owns the payload cache, the CLI gate, and the refresh cadence, which follows popover visibility the way `mac/`'s `RefreshCadence.swift` does.

`cargo test` covers the PATH filter and the version gate. `windows/DEVELOPMENT.md` has the build, security, and release details; CI is `.github/workflows/windows-menubar-ci.yml` and releases go out on `windows-v*` tags.

The Linux (ksni) paths in the same crate are kept compiling but are experimental and unreleased; `gnome/` is the shipping Linux surface.

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

`npm test` runs vitest, scoped to `tests/`. 192 test files live there:

- `tests/` root (141 files) covers CLI, parser, optimize, cache, format, models, plans.
- `tests/security/` (1 file) covers prototype-pollution guards.
- `tests/providers/` (44 files) covers per-provider parsing.
- `tests/sharing/` (6 files) covers the share/export surface.
- `tests/setup/` holds the env-isolation setup file, not specs.
- `tests/fixtures/` holds redacted real-world session data.

The scope is deliberate: the Electron app under `app/` has its own vitest config and its
own `jsdom` dependency, so vitest's default glob must not reach it from a root install.
The three `cache-refresh-lock` suites are excluded from `npm test` and run serially via
`npm run test:locks`, because they exercise a cross-process file lock and fail under full
worker pressure.

Three providers ship without dedicated test files today: `claude`, `goose`, `qwen`. Closing this gap is a standing good-first-issue.

CI runs Semgrep against `.semgrep/rules/no-bracket-assign-hot-paths.yml` over `src/providers/` and `src/parser.ts` (`.github/workflows/ci.yml`). The vitest suite runs in CI too, via `.github/workflows/tests.yml`, on every pull request and every push to `main`.
