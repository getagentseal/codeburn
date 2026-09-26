# CodeBurn Menubar (Windows)

Tauri 2.x tray app that surfaces CodeBurn in the Windows notification area. It is the Windows
mirror of the native macOS menubar in `../mac/`, which stays the authoritative look and feel;
this project mirrors its layout, colors, and data via the shared `tokens.json`.

Linux (ksni / AppIndicator) support is compiled and kept working for dev, but it is
**experimental and unreleased** - Linux users should use the GNOME extension in `../gnome/`.
The releases this repo cuts from here are Windows only.

Not everything crosses over: the spend badge is a second tray icon carrying the number as its
bitmap, which only the Windows notification area provides. `tray_badge` is compiled out on
Linux, the `set_tray_badge` command reports it as unsupported there, and the frontend hides
the control behind `TRAY_BADGE_SUPPORTED` in `src/lib/platform.ts`. Anything else that is
Windows-only must be cfg-gated the same way, or the ubuntu leg of CI fails on dead code.

## Architecture

```
windows/
├── src/              React + TypeScript popover UI (runs inside the Tauri webview)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs   binary entry
│   │   ├── lib.rs    tray, window lifecycle, state wiring
│   │   ├── cli.rs    argv-validated spawn of the codeburn CLI
│   │   ├── config.rs ~/.config/codeburn/config.json read/write under a lock
│   │   ├── plan.rs   Claude OAuth quota (port of mac/.../ClaudeSubscriptionService.swift)
│   │   ├── telemetry.rs consent, event queue and batch POST (twin of app/electron/telemetry.ts)
│   │   └── fx.rs     Frankfurter fetch + 24h disk cache + [0.0001, 1e6] clamp
│   ├── capabilities/ Tauri v2 permission manifests
│   └── icons/        tray + bundle icons
└── tokens.json       shared design tokens (also consumed by mac/ at build time)
```

## Prerequisites (Windows)

```powershell
# Rust
winget install Rustlang.Rustup
rustup target add x86_64-pc-windows-msvc

# WebView2 Runtime
winget install Microsoft.EdgeWebView2Runtime

# Microsoft C++ Build Tools (ships with Visual Studio Installer; pick "Desktop development with C++")
```

## Prerequisites (macOS / Linux, dev only)

Tauri builds on macOS and Linux for inner-loop UI iteration. The shipping macOS product is the
Swift app in `../mac/`, so we don't cut a Tauri Mac release.

```bash
# macOS
brew install rust node

# Ubuntu / Debian
sudo apt update
sudo apt install -y \
  build-essential curl wget file \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  libgtk-3-dev
```

## Run the dev server

```bash
cd windows
npm install
npm run tauri dev
```

Under the hood this starts Vite on `localhost:1420`, builds `src-tauri/target/debug/codeburn-menubar`,
and opens a window wired to the dev server with hot reload for the React code. The tray icon
appears at the same time.

If the codeburn CLI isn't on PATH (dev builds from this monorepo), point the app at your local build:

```bash
npm --prefix .. run build
CODEBURN_BIN="node $(pwd)/../dist/cli.js" npm run tauri dev
```

`CODEBURN_BIN` is validated against a strict allowlist (alphanumerics plus `._/-` and space;
`\ : ( )` also allowed on Windows) before use; anything else falls back to auto-resolution.

Without `CODEBURN_BIN` the app looks for `codeburn` (`codeburn.cmd` / `codeburn.exe` on Windows)
on the inherited `PATH`, then in the usual npm and node prefixes (`%APPDATA%\npm`,
`%LOCALAPPDATA%\Programs\nodejs`, pnpm, Volta, scoop, `/opt/homebrew/bin`, `~/.npm-global/bin`),
and finally on Windows in the live user and machine `PATH` read from the registry, so a CLI
installed after the tray app was launched is still found. Only absolute directory entries are
considered - empty or relative `PATH` entries are skipped so nothing is ever resolved out of the
current working directory.

If nothing is found, or `codeburn --version` is older than `MIN_CLI_VERSION`
(`src-tauri/src/cli.rs`), the popover shows a setup screen with the install command and a
"Check again" button. That gate is probed once on mount, before the first payload fetch.

`MIN_CLI_VERSION` is **0.9.9**: the first release whose `codeburn status --format menubar-json`
accepts `--no-optimize`, which the app's quiet background refreshes always pass. Every payload
field the popover reads (`current.providers`, `current.cacheHitPercent`, `history.daily[].topModels`)
also exists at that version.

## Refresh policy

Mirrors `mac/Sources/CodeBurnMenubar/RefreshCadence.swift`: each CLI fetch is a full Node
process, so the cadence follows popover visibility.

- popover visible: 60 s tick, full fetch (optimize findings included)
- popover hidden: 120 s tick, `today`/`all` only, `--no-optimize`
- on show: immediate refresh when the visible key is older than 60 s

## Plan / quota

The Plan pill (visible on the Claude tab, or when Claude is the only detected provider) reads
Claude Code's OAuth credentials from `~/.claude/.credentials.json`, calls
`https://api.anthropic.com/api/oauth/usage`, and stores one snapshot per window under
`~/.cache/codeburn/subscription-snapshots.json` (`CODEBURN_CACHE_DIR` override) so a freshly
reset window can still show last cycle's final. This is the same file format the macOS app
writes. Nothing is logged: the credential blob never leaves the Rust side.

On a 401 we do **not** call the token refresh endpoint. Claude's refresh token is single-use
and rotates, so spending it would invalidate the token Claude Code itself is holding and break
the user's login. Like `ClaudeCredentialStore.refreshAfter401` on macOS, we re-read Claude's
own credential file for a token it has already rotated, and report a transient failure when
there isn't one yet.

The `keepExpanded` dock preference (Settings > General > Capacity Dock > Keep expanded) makes
the rail read as pinned, so every selected ring stays out at rest and the hover-out collapse
never runs.

## Build a production package

```bash
# Windows (.msi): run from a Windows host
npm run tauri build

# Linux (experimental): produces .deb, .rpm, .AppImage under src-tauri/target/release/bundle/
npm run tauri build
```

## Security model

- **Process spawn**: every call into the codeburn CLI goes through `CodeburnCli::fetch_menubar_payload`,
  which builds argv explicitly and runs the binary directly (no `sh -c`). `CODEBURN_BIN` is
  allowlisted before use. Windows system tools (`reg.exe`, `cmd.exe`) are invoked by absolute
  path under `%SystemRoot%\System32` so `CreateProcess`'s current-directory search can never
  pick up a planted binary; `claude` is resolved from absolute `PATH` directories the same way.
- **Pipes**: stdout is capped at 20 MB, stderr at 256 KB, total wall time at 60 s. A hung CLI
  cannot pin file descriptors or memory.
- **Config writes**: `~/.config/codeburn/config.json` writes run under a POSIX `flock` on
  `~/.config/codeburn/.config.lock`. On Windows the same path uses a create-new lock file. Note
  that this lock is advisory *between instances of this app only* - the codeburn CLI does not
  take it - so it narrows, but does not eliminate, a concurrent-write race. A live holder keeps
  its file handle open and Windows will not unlink an open file, so the staleness sweep can only
  ever reclaim a lock whose owner is gone (after 30 s).
- **Snapshot writes**: `subscription-snapshots.json` refuses a symlinked target and is written
  0600 on unix, mirroring `mac/Sources/CodeBurnMenubar/Security/SafeFile.swift`.
- **Credentials**: the Plan view reads `~/.claude/.credentials.json` with a 64 KB cap and refuses
  symlinks; the access token is only ever sent to the Anthropic usage endpoint over TLS, and the
  refresh token is never read or sent at all.
- **FX fetches**: Frankfurter response is parsed as JSON and the rate is clamped to
  `[0.0001, 1_000_000]` before it touches displayed numbers. Stale cache preferred over poisoned
  fresh data.
- **Update check**: the GitHub releases request is HTTPS-only (redirects included), carries a
  30 s timeout and a response cap, and runs in Rust, so the webview never reaches
  api.github.com and the CSP does not have to let it. Nothing is downloaded or executed
  here: `codeburn menubar --force` does the install, which is what verifies the sha256.
  Subprocess stderr is capped at 64 KB and scrubbed of API keys, JWTs and bearer tokens
  before any of it is shown.
- **CSP**: `connect-src` restricted to `self` and `ipc:`. No inline scripts. The Frankfurter
  rate is fetched in Rust (`fx.rs`), as the GitHub check is, so the webview needs no host of
  its own and is not given one.

## CI and release tags

- `.github/workflows/windows-menubar-ci.yml` runs on any `windows/**` change: `tsc --noEmit`,
  `cargo clippy -D warnings` and `cargo test` on windows-latest + ubuntu-latest, plus a release
  build smoke on Windows.
- `windows-v*` tag (e.g. `windows-v0.9.20`) triggers
  `.github/workflows/release-menubar-windows.yml`; publishes the `.msi` (plus its sha256) to
  a "Windows Menubar vX" release. Unsigned for now, so Windows SmartScreen prompts on first run
  until a signing cert is in place.
- `codeburn menubar` installs from those assets (`src/menubar-installer.ts`): it pins the tag to
  the CLI's own version (`windows-v<cliVersion>`), falls back to a scan of the newest `windows-v*`
  release carrying both assets, verifies the sha256 before anything executes the file, then runs
  `%SystemRoot%\System32\msiexec.exe /i <msi> /passive /norestart` and launches the exe named by
  the product's Uninstall registry key. Renaming the bundle or the MSI asset breaks that lookup —
  `WINDOWS_RELEASE` and `WINDOWS_PRODUCT_NAME` in the installer have to move with it.

## Updates

`src-tauri/src/update.rs` is the port of `mac/.../Data/UpdateChecker.swift`.

- Every two days it reads the releases API and looks for the newest `windows-v*` release
  carrying both a `CodeBurn.Menubar_<version>_x64_en-US.msi` and its `.sha256`, and for the
  newest CLI release, whose tags are a bare `v*`. The answer is cached in
  `%LOCALAPPDATA%\codeburn-menubar\update.json`, so a relaunch inside the interval costs no
  request and a failed check keeps whatever the cache held.
- The surfaces are the header update badge, the CLI update banner under the footer, and
  Check for Updates in the tray menu and in About. The tray item opens About on the
  `about#check` anchor, which is where the up to date / update available / check failed
  result is shown, and where the button that installs it lives.
- There is no install button. Outside a Store package the app only reports that a newer
  version exists, opens the `windows-v*` release page, and shows `codeburn menubar --force`
  as the manual command, because the MSI is unsigned and its checksum comes from the same
  release (the module doc in `update.rs` has the reasoning). Inside a Store package the
  checker stands down, since Store updates cover it. `MIN_CLI_VERSION_FOR_UPDATE` is
  **0.9.21**, the first CLI whose `menubar` can install a Windows app at all; an older one
  is told to update the CLI first.
- Renaming the MSI asset breaks the version lookup here as well as in the installer:
  `MSI_PREFIX` / `MSI_SUFFIX` have to move with `WINDOWS_RELEASE`.

## Telemetry

`src-tauri/src/telemetry.rs` is the Windows twin of `app/electron/telemetry.ts`. Both post the
same envelope to the same endpoint, so the desktop app and the tray app land in one table and
are told apart by `app.name` (`codeburn-desktop` against `codeburn-menubar`). Read that file's
module doc before changing anything here: its invariants are the contract.

- **Consent.** The desktop app's state file wins whenever it exists:
  `%APPDATA%\codeburn-desktop\telemetry.v1.json` supplies `installId`, `enabled` and
  `onboardedAt`, and this app never writes it. One decision then covers both apps and their
  events join on one id. Standalone, the decision lives in this app's own
  `~/.config/codeburn/windows-settings.json` as `telemetryEnabled`, `telemetryOnboardedAt` and
  `telemetryInstallId`, defaulting off for EU / EEA / UK / CH and for an unknown region and on
  elsewhere, from the Windows user locale. A standalone install is asked once, by the notice in
  the popover and in Settings > General > Privacy; nothing is queued or sent before it answers.
  Switching the toggle off mints a fresh install id and empties the queue, as the desktop does.
- **Events.** `app_open` and `app_close` (`sessionMinutes`), `popover_open`, `settings_open`
  (`pane`), `update_click` (`action`), `glance_open`, `dock_enabled` / `dock_disabled` (`edge`,
  `scaleBucket`), `dock_provider_switch` (`provider`), `dock_drag_end` (`edge`) and
  `usage_snapshot`, which forwards the `telemetrySnapshot` object out of the CLI's menubar
  payload at most once a calendar day, and only when the desktop app is not the consent source
  (that app sends the same aggregate from the same payload). An unknown name is dropped, and
  every prop goes through the same whitelist sanitizer the desktop uses: every leaf is a
  short string, a finite number or a boolean, and the nesting (5), key count (16), array
  length (12) and leaf count (1000) are all capped.
- **Transport.** The queue is persisted to
  `%LOCALAPPDATA%\codeburn-menubar\telemetry-queue.json` after every change, so a crash or a
  quit loses nothing, and is capped at 200 events with the oldest giving way. A batch goes out
  every five minutes and once more on quit with a short timeout; a 4xx drops the batch, a 5xx
  or a dead network keeps it for the next beat. Debug builds never send unless
  `CODEBURN_TELEMETRY_DEV=1`.
- **The pages** report through `src/lib/telemetry.ts`, which invokes `telemetry_track`. It has
  no gate of its own on purpose: Rust owns every decision, so a page never has to know the
  current one. `dock_enabled` / `dock_disabled` are the exception and come from
  `set_dock_enabled` in `lib.rs`, the one funnel the tray item, the settings toggle and the
  dock's own Hide item all pass through.

## Pending work

1. Code signing for the Windows `.msi` to remove the SmartScreen warning.
2. Linux: decide whether to ship at all (the GNOME extension in `../gnome/` covers that
   surface today) or promote the ksni tray out of experimental.
