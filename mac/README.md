# CodeBurn Menubar (macOS)

Native Swift + SwiftUI menubar app. The codeburn menubar surface.

## Requirements

- macOS 14+ (Sonoma)
- Swift 6.0+ toolchain (bundled with Xcode 16 or standalone)
- `codeburn` CLI installed globally (`npm install -g codeburn`)

## Install (end users)

One command:

```bash
codeburn menubar
```

That's it. The command records the persistent `codeburn` CLI path, downloads the latest `.app` from the newest `mac-v*` GitHub Release with a matching checksum, verifies it, drops it into `~/Applications`, clears Gatekeeper quarantine, and launches it. Re-running it upgrades in place with `--force`, or just launches the existing copy otherwise.

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
CODEBURN_ALLOW_DEV_BIN=1 CODEBURN_BIN="node $(pwd)/../dist/cli.js" swift run
```

The app registers itself as a menubar accessory (`LSUIElement = true` at runtime). No Dock icon.

## Data source

On launch and on the configured refresh cadence (30 seconds by default, or Manual), the app spawns `codeburn status --format menubar-json --no-optimize` directly (argv, no shell) via `CodeburnCLI.makeProcess` and decodes the JSON into `MenubarPayload`. The manual refresh button in the footer invokes the same command without `--no-optimize`, which includes optimize findings but takes longer.

Release installs record a persistent absolute CLI path in `~/Library/Application Support/CodeBurn/codeburn-cli-path.v1`, then fall back to Homebrew's common `codeburn` locations. For development only, set `CODEBURN_ALLOW_DEV_BIN=1` with `CODEBURN_BIN`; the value is validated against a strict allowlist before use, so a malicious env var can't inject shell commands.

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
