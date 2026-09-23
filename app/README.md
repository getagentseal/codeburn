# CodeBurn Desktop

Electron desktop shell for CodeBurn's local-first usage views. M1 runs as a developer app and reads data by spawning the installed `codeburn` CLI; it does not run a daemon or HTTP server.

## Development

```sh
npm --prefix app install
npm --prefix app run dev
```

Validation:

```sh
npm --prefix app run test
npm --prefix app run typecheck
```

## CLI Dependency

Packaged builds ship their own version-matched copy of the `codeburn` CLI and require nothing installed — the app spawns the bundled CLI with Electron's own binary as Node (`ELECTRON_RUN_AS_NODE`). In development (Vite dev server) the app uses the repo's freshly-built CLI, and either can be overridden with `CODEBURN_BIN` or a persisted path file. See `DISTRIBUTION.md` for the bundling and resolution details. Electron resolves and spawns the CLI from the main process, then sends decoded JSON through the secure preload bridge into the renderer.

This follows the menubar pattern:

- `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Renderer code calls `window.codeburn` only through `app/renderer/lib/ipc.ts`.
- Main process handlers return JSON envelopes so structured CLI errors survive IPC.
- Missing CLI, bad JSON, timeout, and nonzero exits are surfaced as honest UI states.
- The renderer never imports CodeBurn engine code from `src/`; the data contract is spawn CLI, decode JSON, poll.

## Data Contract

Current bridge calls:

- Overview: `codeburn status --format menubar-json --period <period> [--provider <provider>]`
- Plans: `codeburn status --format json --period <period>`
- Models: `codeburn models --format json --period <period> [--provider <provider>] [--by-task]`
- Optimize: `codeburn yield --format json --period <period>`
- Spend flow: `codeburn spend --format flow-json --period <period> [--provider <provider>]`
- Devices: `codeburn devices --format json --period <period>`
- Device scan: `codeburn devices scan --format json`
- Share status: `codeburn share status --format json`
- Identity: `codeburn identity --format json`

Supported M1 periods are `today`, `week`, `30days`, `month`, and `all`. Provider filtering is passed through where the CLI command supports it.

## Refresh tiers

Not every call runs at the same cadence. The headline overview is the only live poll; it asks for neither optimize findings nor a fresh act report. `act report` refreshes on mount, on a manual refresh, and every 10 minutes; `yield` every 5. The optimize scan runs at most once a day per query scope, is stored in `userData` with the time it was computed, is reused only on the same local day, and is forced fresh by the Optimize page or a manual refresh. A figure that is not live is shown with its age. On battery the live interval doubles. While the window is hidden the app stops polling and animating altogether, and catches up immediately when it comes back.

The CLI is spawned once as a resident `codeburn serve --stdio` child rather than per request. After 15 idle minutes it is retired and the next request starts a new resident; `CODEBURN_SERVE_IDLE_MS` tunes or disables that.

## Sections

- Overview: daily spend, spend stats, waste summary, and expensive sessions from `menubar-json`.
- Spend: project/activity/tool/MCP/subagent lenses plus model-to-project flow.
- Optimize: waste findings from `menubar-json` and reverted/abandoned yield data.
- Models: model and task tables from `models --format json`.
- Plans: plan pacing from `status --format json`.
- Settings: device identity, nearby scan results, paired-device usage, and M2 visual affordances.

## Packaging

`npm run package` produces a macOS `.dmg`/`.zip` (arm64 and x64) via `electron-builder`. Release builds are signed with a Developer ID Application certificate and notarized by Apple (ad-hoc signing is only a fallback when no signing identity is configured). Packaging rebuilds the root CLI and bundles it into the app (`Resources/cli`), so installs need nothing on the target machine. See `DISTRIBUTION.md` for build instructions, the bundled-CLI mechanism, artifact locations, and the notarization process.

## M2 Backlog

- Add Electron `autoUpdater` (the app already bundles its own version-matched CLI, so end-user installs need nothing on the machine; auto-update is the remaining piece).
- Keep npm as a separate CLI-user channel at the same version as the desktop app.
- Add a `codeburn desktop` launcher subcommand.
- Implement in-app pairing, approve, pull, and visibility mutations currently shown as M2 affordances.
- Build the Models Compare sheet.
- Expand `codeburn optimize --format json` with evidence and fix commands so Optimize can show richer actionable fixes.
