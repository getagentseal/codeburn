# CodeBurn Desktop (Linux + Windows)

Tauri 2.x app that surfaces CodeBurn in the system tray on Linux and Windows. The macOS build lives in `../mac/` and is the authoritative look and feel; this project mirrors its layout, colors, and data via the shared `tokens.json`.

## Architecture

```
desktop/
├── src/              React + TypeScript popover UI (runs inside the Tauri webview)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs   binary entry
│   │   ├── lib.rs    tray, window lifecycle, state wiring
│   │   ├── cli.rs    argv-validated spawn of the codeburn CLI
│   │   ├── config.rs ~/.config/codeburn/config.json read/write with flock
│   │   └── fx.rs     Frankfurter fetch + 24h disk cache + [0.0001, 1e6] clamp
│   ├── capabilities/ Tauri v2 permission manifests
│   └── icons/        tray + bundle icons (placeholders until branded assets land)
└── tokens.json       shared design tokens (also consumed by mac/ at build time)
```

## Prerequisites (Ubuntu / Debian)

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  libgtk-3-dev

# Rust (prefer rustup so nightly / targets are easy to add)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu

# Node (20+). If you already have the codeburn CLI installed globally, you're set.
```

## Prerequisites (macOS, dev only)

Tauri runs on macOS for inner-loop UI iteration. The shipping macOS product is the Swift app in `../mac/`, so we don't cut a Tauri Mac release.

```bash
brew install rust node
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

## Run the dev server

```bash
cd desktop
npm install
npm run tauri dev
```

Under the hood this starts Vite on `localhost:1420`, builds `src-tauri/target/debug/codeburn-desktop`, and opens a window wired to the dev server with hot reload for the React code. The tray icon appears at the same time.

If the codeburn CLI isn't on PATH (dev builds from this monorepo), point the app at your local build:

```bash
npm --prefix .. run build
CODEBURN_BIN="node $(pwd)/../dist/cli.js" npm run tauri dev
```

`CODEBURN_BIN` is validated against a strict allowlist (alphanumerics plus `._/-` and space) before use; anything else falls back to the `codeburn` name resolved through `PATH`.

## Build a production package

```bash
# Linux: produces .deb, .rpm, .AppImage under src-tauri/target/release/bundle/
npm run tauri build

# Windows (.msi): run from a Windows host
npm run tauri build
```

## Security model

- **Process spawn**: every call into the codeburn CLI goes through `CodeburnCli::fetch_menubar_payload`, which builds argv explicitly and runs the binary directly (no `sh -c`). `CODEBURN_BIN` is allowlisted before use.
- **Pipes**: stdout is capped at 20 MB, stderr at 256 KB, total wall time at 60 s. A hung CLI cannot pin file descriptors or memory.
- **Config writes**: `~/.config/codeburn/config.json` writes run under a POSIX `flock` on `~/.config/codeburn/.config.lock` so a concurrent CLI invocation and this app cannot race.
- **FX fetches**: Frankfurter response is parsed as JSON and the rate is clamped to `[0.0001, 1_000_000]` before it touches displayed numbers. Stale cache preferred over poisoned fresh data.
- **CSP**: `connect-src` restricted to `self`, `ipc:`, and `https://api.frankfurter.app`. No inline scripts.

## Release tags

- `linux-v*` -- triggers `.github/workflows/release-desktop-linux.yml`; publishes `.deb`, `.rpm`, `.AppImage`.
- `win-v*` -- triggers `.github/workflows/release-desktop-windows.yml`; publishes `.msi`. Unsigned for now, so Windows SmartScreen prompts on first run until a signing cert is in place.

## Pending work

1. ~~Scaffold Tauri 2.x + shared tokens + placeholder icons~~
2. ~~Data wiring: `fetch_payload` + React rendering of hero, activity, models~~
3. Full popover parity with mac/ (trend chart, forecast, pulse, stats, plan pills)
4. ~~Currency picker instant switch + Frankfurter fetch~~
5. ~~Linux release workflow (`ubuntu-latest`): `.deb`, `.AppImage`, `.rpm`~~ (Flatpak manifest still TODO)
6. ~~Windows release workflow (`windows-latest`): `.msi`~~
7. Icon pass (vector flame replacing the terracotta-square placeholders)
8. Code signing for Windows `.msi` to remove the SmartScreen warning
