# CodeBurn Menubar (macOS)

Native Swift + SwiftUI menubar app. The codeburn menubar surface.

## Requirements

- macOS 14+ (Sonoma)
- Swift 6.0+ toolchain (bundled with Xcode 16 or standalone)
- `codeburn` CLI installed globally (`npm install -g codeburn`) or available at a path you pass via `CODEBURN_BIN`

## Install (end users)

One command:

```bash
npx codeburn menubar
```

That's it. The command downloads the latest `.app` from GitHub Releases, drops it into `~/Applications`, clears Gatekeeper quarantine, and launches it. Re-running it upgrades in place with `--force`, or just launches the existing copy otherwise.

If you already have the CLI installed globally (`npm install -g codeburn`), `codeburn menubar` works the same way.

### Build from source

For contributors running a local build instead of the packaged release:

```bash
npm install -g codeburn                       # CLI the app shells out to for data
git clone https://github.com/getagentseal/codeburn.git
cd codeburn/mac
swift build -c release
.build/release/CodeBurnMenubar                # launch
```

## Build & run (dev against a local CLI checkout)

```bash
cd mac
swift build
# Point the app at your dev CLI build instead of the globally installed `codeburn`:
npm --prefix .. run build
CODEBURN_BIN="node $(pwd)/../dist/cli.js" swift run
```

The app registers itself as a menubar accessory (`LSUIElement = true` at runtime). No Dock icon.

## Data source

On launch and every 60 seconds thereafter, the app spawns `codeburn status --format menubar-json --no-optimize` directly (argv, no shell) via `CodeburnCLI.makeProcess` and decodes the JSON into `MenubarPayload`. The manual refresh button in the footer invokes the same command without `--no-optimize`, which includes optimize findings but takes longer.

Override the binary via the `CODEBURN_BIN` environment variable (default: `codeburn` on PATH). The value is validated against a strict allowlist (alphanumerics plus `._/-` space) before use, so a malicious env var can't inject shell commands.

## Project layout

```
mac/
├── Package.swift                     SwiftPM manifest
├── Sources/CodeBurnMenubar/
│   ├── CodeBurnApp.swift             @main + MenuBarExtra scene
│   ├── AppStore.swift                @Observable store + enums
│   ├── Data/MenubarPayload.swift     Codable payload types + placeholder
│   ├── Theme/Theme.swift             Design tokens (warm terracotta palette)
│   └── Views/MenuBarContent.swift    Popover layout + footer action bar
└── README.md                         This file
```

## Status

Live data wired. Next iterations:

1. FSEvents watch for `~/.claude/projects/` changes (debounced refresh on real edits)
2. Persistent disk cache for optimize findings so the default refresh can include them without the 30-second penalty
3. Currency metadata in the JSON payload + Swift-side formatting
4. Sparkle auto-update
5. DMG packaging + Homebrew Cask tap

## Design tokens

Sourced from `~/codeburn-menubar-mac-swiftui.html`. Warm terracotta-ember palette:

- Accent (light): `#C9521D`
- Accent (dark): `#E8774A`
- Ember deep: `#8B3E13`
- Ember glow: `#F0A070`
- Surface (light): `#FAF7F3`
- Surface (dark): `#1C1816`

SF Mono for currency values; SF Pro Rounded for hero.
