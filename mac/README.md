# CodeBurn Menubar (macOS)

Native Swift + SwiftUI menubar app. The codeburn menubar surface.

## Requirements

- macOS 14+ (Sonoma)
- Swift 6.0+ toolchain (bundled with Xcode 16 or standalone)
- `codeburn` CLI installed globally (`npm install -g codeburn`)

## Language

The app ships English, French, Japanese, Korean, Simplified Chinese (`zh-Hans`)
and Traditional Chinese (`zh-Hant`), and follows your system language.
Settings > General > Language overrides it for CodeBurn alone, with
System as the default, and the change applies in place, with no relaunch:
macOS resets the "access data from other apps" permission whenever the app
quits, so a relaunch would re-prompt Warp users on every switch. It writes
`AppleLanguages` into CodeBurn's own preferences domain, which is the same key
System Settings > General > Language & Region > Applications writes, so the two
are one setting rather than two. The desktop app's Language setting drives the
same choice.

Strings live in `Sources/CodeBurnMenubar/Resources/<locale>.lproj/Localizable.strings`
and are reached through `L(_:)` / `L(_:_:)` (see `Localization.swift`). The key
*is* the English copy, so an untranslated string shows correct English rather
than an identifier, and `en.lproj` is an identity table.

To add a language, copy `en.lproj` to `<locale>.lproj`, translate the values,
then add the locale in three places that must stay in step: `.process` in
`Package.swift`, `CFBundleLocalizations` in both `Scripts/package-app.sh` and
`Scripts/build-local.sh`, and `L10n.supportedLocalizations`.
`LocalizationCatalogTests` fails if they disagree, if a key is missing from
either table, if a value is blank, or if the format specifiers do not match.

## Install (end users)

One command:

```bash
codeburn menubar
```

That's it. The command records the persistent `codeburn` CLI path, downloads the latest `.app` from the newest `mac-v*` GitHub Release with a matching checksum, verifies it, installs it, clears Gatekeeper quarantine, and launches it. A bundle that is already in `/Applications` or `~/Applications` is replaced where it lives, so no second copy and no second login item appear; the old bundle is moved aside and restored on any failure, a cross-volume move falls back to a copy that is re-verified with `codesign`, and an unwritable location is never escalated into, the install goes to `~/Applications` and the leftover copy is named for you. An install killed part way is recovered on the next run, and a concurrent install is refused. Re-running it upgrades in place with `--force`, or just launches the copy that exists otherwise. `codeburn menubar --uninstall` removes it.

### Build from source

For contributors running a local build instead of the packaged release:

```bash
npm install -g codeburn                       # CLI the app shells out to for data
git clone https://github.com/getagentseal/codeburn.git
cd codeburn/mac
swift build -c release
.build/release/CodeBurnMenubar                # launch
```

#### On macOS 14 (Sonoma) without Xcode 16

`swift build` above assumes the macOS 15 SDK, whose SwiftUI marks the `View`
protocol `@MainActor`. The Sonoma SDK (shipped with Command Line Tools) lacks
that annotation, so a plain build fails with ~80 `main actor-isolated ... from a
nonisolated context` errors.

(The `-10825` launch failure itself is fixed by `Package.swift`'s `.macOS(.v14)`
deployment target: ld64 drops the macOS-15-only `libswift_errno.dylib`
dependency for any build with that target, regardless of which SDK built it, including the CI-distributed release. This local-build path exists only for
the narrower case of building on a Sonoma machine with nothing but the
Command Line Tools, where the SDK's un-annotated `View` protocol needs the
`@MainActor` patch below.)

Use the helper, which builds against the local macOS 14 SDK with a standalone
[swift.org](https://www.swift.org/install/macos/) Swift 6.x toolchain and
adds explicit `@MainActor` to the views in a scratch copy (repo sources stay
clean), producing a `minos = 14.0` bundle installed to `~/Applications`:

```bash
mac/Scripts/build-local.sh         # then: codeburn menubar
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

A `swift run` or Xcode build is matched against the installed app by executable name, and
being the newest start it retires the installed copy as it comes up. Pass `--keep-both` to
run yours alongside it (`swift run CodeBurnMenubar --keep-both`).

## Data source

On launch and every 60 seconds thereafter, the app spawns `codeburn status --format menubar-json --no-optimize` directly (argv, no shell) via `CodeburnCLI.makeProcess` and decodes the JSON into `MenubarPayload`. The manual refresh button in the footer invokes the same command without `--no-optimize`, which includes optimize findings but takes longer.

Requests go through a resident `codeburn serve --stdio` child, which keeps the parsed corpus warm. After 15 idle minutes it is retired, without counting as an unexpected death, and the next request starts a new resident rather than a one-shot. `CodeBurnServeIdleSeconds` tunes or disables that.

Release installs record a persistent absolute CLI path in `~/Library/Application Support/CodeBurn/codeburn-cli-path.v1`, then fall back to common Homebrew and Node-manager locations. GUI launches augment the minimal macOS PATH with Volta, npm-global, asdf, mise, and nvm runtime locations so a persisted JavaScript launcher also works when the app is opened from Spotlight. For development only, set `CODEBURN_ALLOW_DEV_BIN=1` with `CODEBURN_BIN`; the value is validated against a strict allowlist before use, so a malicious env var can't inject shell commands.

## Project layout

```
mac/
├── Package.swift                     SwiftPM manifest (deployment target: macOS 14)
├── Scripts/
│   ├── package-app.sh                CI: universal signed .app + zip + checksum
│   └── build-local.sh                Local macOS 14 build (Sonoma SDK + @MainActor patch)
├── Sources/CodeBurnMenubar/
│   ├── CodeBurnApp.swift             @main + MenuBarExtra scene
│   ├── AppStore.swift                @Observable store + enums
│   ├── Localization.swift            L(_:) lookups against the module bundle
│   ├── Resources/en.lproj/           Localizable.strings (identity table)
│   ├── Resources/fr.lproj/           Localizable.strings (français)
│   ├── Resources/ja.lproj/           Localizable.strings (日本語)
│   ├── Resources/ko.lproj/           Localizable.strings (한국어)
│   ├── Resources/zh-Hans.lproj/      Localizable.strings (简体中文)
│   ├── Resources/zh-Hant.lproj/      Localizable.strings (繁體中文)
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
