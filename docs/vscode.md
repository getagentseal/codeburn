# VS Code extension

The extension (`codeburn.codeburn`, source in `vscode/`) puts CodeBurn in VS Code and the editors built on it: a status bar item, an activity bar summary, and the desktop dashboard in an editor tab, scoped to the open workspace.

## How it is built

Nothing is forked. The extension reuses three things the desktop app already has:

| Piece | Reused from | How |
|:--|:--|:--|
| CLI client | `app/electron/cli.ts` | The same resident `codeburn serve --stdio` child, watchdog, restart budget, idle retire and one-shot fallback. Bundled into the extension host. |
| Channel to argv mapping | `app/electron/bridge-handlers.ts` | `createBridgeHandlers`, moved out of `main.ts` so it has no `electron` import. Same validators, same project filter, same daily optimize cache. |
| Dashboard | `app/renderer` | Built a second time by `app/vite.vscode.config.ts` with two entries: `renderer/vscode/dashboard.tsx` (the whole `App`) and `renderer/vscode/sidebar.tsx` (the activity bar summary). |

The renderer talks to `window.codeburn`. In the webview that object is `renderer/vscode/bridge.ts`: every forwarded method becomes a `postMessage` to the extension host, which answers it with the shared handlers (`vscode/src/host.ts`). Only the channels in `renderer/vscode/channels.ts` are forwarded; the host refuses anything else. Telemetry, update checks and the desktop's tray and menu bar companions are answered inside the webview and never cross.

The webview's Content Security Policy allows scripts, styles, images and media only from the extension's own files (`asWebviewUri`). Boot data rides in a JSON block, so there is no inline script.

The bundled CLI lives in `vscode/cli/`, staged by `vscode/scripts/stage-cli.mjs` the same way `app/scripts/stage-cli.mjs` stages it for the desktop app, including the launch shim that corrects Commander's argv under Electron-as-Node.

## Runtime

The CLI needs Node 22.13 or later, and `node:sqlite` (Node 22.5+) for Cursor, OpenCode and Copilot. Measured on 6 Oct 2026 with `ELECTRON_RUN_AS_NODE=1`:

| Editor | Version | Electron | Node | `node:sqlite` |
|:--|:--|:--|:--|:--|
| VS Code | 1.140.0 | 43.7.3 | 24.21.0 | yes |
| Cursor | 3.23.12 (VS Code 1.128) | 42.10.0 | 24.18.1 | yes |
| Antigravity | 2.19.1 | 44.3.0 | 24.20.0 | yes |

So on current editors the CLI runs on the editor's own Node (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), exactly as the desktop app runs it on Electron. `vscode/src/runtime.ts` picks, in order:

1. `codeburn.nodePath`, if it is Node 22.13+ with `node:sqlite`;
2. the editor's own Node, if it is;
3. the first `node` on `PATH` or in Homebrew, nvm, Volta, asdf or npm-global that is;
4. the editor's own Node anyway, with a one-time warning and a note in the summary and tooltip naming what it cannot read.

An older editor (VS Code before 1.101 ships Node 20) lands on step 3 or 4. The choice reaches the shared client through `CODEBURN_NODE_BIN`, which `cli.ts` uses instead of Electron-as-Node when it is set.

## Workspace scope

A workspace folder maps to the project path the CLI files sessions under (`src/parser.ts`, `resolveCanonicalProjectPath`): the folder itself, or the main repository for a linked git worktree. Each folder becomes a rooted `--project=<path>` pattern, which matches that path and everything below it. The saved project filter's excludes still apply; its includes give way to the workspace. The dashboard keeps each scope's cached views apart by prefixing its localStorage keys with the scope.

## Several windows

Every editor window has its own extension host and its own serve child. A window polls only while it is focused or its summary is visible, and its idle child retires after five minutes (the desktop keeps fifteen). Serve pid files are per host process, so a window never reaps another window's child, and a crashed window's child is reaped by the next one to start.

## Building and testing

```
npm ci && (cd app && npm ci) && (cd vscode && npm ci)
npm run package:vscode          # dist/, cli/, then vscode/codeburn-<version>.vsix
cd vscode && npm test           # unit tests
cd vscode && npm run test:smoke # a real VS Code against a fixture home
```

`test:smoke` downloads VS Code stable (CI runs it under `xvfb-run`). On macOS, `CODEBURN_SMOKE_APP="/Applications/Visual Studio Code.app" npm run test:smoke` uses an installed editor instead, launched hidden as a separate instance. It checks activation, every command, the CLI's numbers through Copy Summary (all projects and the workspace scope against the CLI's own output), and the dashboard's scope switch.

## Forks

The extension uses no proposed APIs and declares `engines.vscode: ^1.82.0`, so it installs in VS Code, Cursor, Windsurf, Antigravity and VSCodium, and can be published to Open VSX. Cursor and Antigravity were checked for their Node and `node:sqlite` above; Windsurf and VSCodium were not available to test.
