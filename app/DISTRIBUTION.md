# Distributing CodeBurn Desktop

This document describes how to produce distributable macOS, Windows, and Linux
builds of the Electron desktop app. The macOS build is ad-hoc-signed and
**not notarized** (no paid Apple Developer account); the Windows and Linux
builds are **unsigned**. There is no CI automation for any of this yet (unlike
the CLI and menubar release processes in `../RELEASING.md`) — packaging is run
by hand on a maintainer's machine. All three targets are produced by
`electron-builder` and can be cross-built from a single macOS host.

## The bundled CLI (no install prerequisite)

The packaged app ships its own copy of the `codeburn` CLI and needs nothing
installed on the target machine. Packaging stages a self-contained copy of the
root repo's CLI into `app/build/cli` (see `scripts/stage-cli.mjs`) — the tsup
bundle (`dist/main.js`), its Node-version launcher (`dist/cli.js`), the root
`package.json` (the bundle reads its `version`), plus the CLI's production
`node_modules` closure. An `afterPack` hook (`scripts/after-pack.cjs`) copies
that tree into the app at `Contents/Resources/cli/` after packaging and before
signing, so it lands inside the code signature.

At runtime a packaged build spawns the bundled CLI with Electron's own binary
acting as Node (`ELECTRON_RUN_AS_NODE=1`), so **no Node install is required** —
the app is version-matched to itself. `main.ts` sets `CODEBURN_BUNDLED_CLI` to
`Resources/cli/dist/launch.js` (a small shim that corrects `argv` for
commander under Electron, then hands off to `main.js`), and `electron/cli.ts`
resolves it ahead of any persisted path or `PATH` lookup.

A user-installed CLI is only consulted **outside** a packaged build (dev via the
Vite dev server) or when explicitly overridden — `CODEBURN_BIN=/abs/path`, or a
persisted path file (`Application Support/CodeBurn/codeburn-cli-path.v1`). The
full resolution order in `electron/cli.ts` is: `CODEBURN_BIN` → dev repo CLI
(Vite) → bundled CLI → persisted path → `PATH`/Homebrew/nvm/volta/asdf.

### Freshness

Packaging **always rebuilds the root CLI** before staging: the app `stage-cli`
script runs the root `build:cli` (tsup only — no dashboard build, no network
`bundle-litellm` fetch), so `dist/main.js` and `dist/cli.js` are regenerated
from current `src/` on every `package*` run. A stale global `codeburn` can never
ship, and the app can never be older than the JSON surfaces it calls. The
bundled CLI's deps are pure JS (no native bindings), so the same staged tree is
valid for every arch.

### Why `afterPack`, not `extraResources`

electron-builder routes every `node_modules` directory it copies through its
production-dependency filter, which keeps only the *app's* own deps — so the
bundled CLI's dependency tree gets stripped out of an `extraResources` copy
(`filter: ["**/*"]` does not defeat this). `afterPack` copies the staged tree
in verbatim, which is the electron-builder-recommended mechanism for adding
unpacked files that must not be ASAR-archived.

## Versioning

`app/package.json`'s `version` tracks the CLI's version (root
`package.json`) — one CodeBurn version across CLI, menubar, and desktop.
Bump it in the same change that bumps the root version; the splash, the
About dialog, and the artifact filenames all read it from there.

## Build

```sh
npm --prefix app install
npm --prefix app run package          # macOS, both arm64 and x64
npm --prefix app run package:arm64    # macOS arm64 only (faster on Apple Silicon)
npm --prefix app run package:x64      # macOS x64 only
npm --prefix app run package:win      # Windows NSIS installer, x64
npm --prefix app run package:linux    # Linux AppImage, x64
```

`package` runs `npm run stage-cli` (rebuilds the root CLI and stages the
self-contained bundle into `app/build/cli`; see "The bundled CLI" above), then
`npm run build` (compiles `electron/` with `tsc`, builds the renderer with
`vite`), then `electron-builder --mac` (whose `afterPack` hook copies the
staged CLI into the app). `package:win` and `package:linux` mirror it exactly,
swapping the final flag for `electron-builder --win` and `electron-builder
--linux`. All three can run on the same macOS host — electron-builder downloads
the NSIS and AppImage tooling on first use.

### Artifacts

electron-builder writes to `app/release/` (gitignored, like `dist/`):

- `CodeBurn-<version>-arm64.dmg`, `CodeBurn-<version>.dmg` — installer images
- `CodeBurn-<version>-arm64-mac.zip`, `CodeBurn-<version>-mac.zip` — zipped `.app` bundles
- `release/mac-arm64/CodeBurn.app`, `release/mac/CodeBurn.app` — the raw unpacked bundles (arm64 and x64 respectively)
- `.blockmap` files alongside each zip/dmg (used by electron-builder's differential-update mechanism; unused since this app has no auto-updater yet)

Both `dmg` and `zip` targets are built for both `arm64` and `x64` — four
artifacts total, not a universal binary. This keeps each download roughly
half the size of a universal build. Pick the zip if you just want to unpack
and drag to `/Applications`; the dmg gives users the familiar drag-to-Applications
installer window.

### Build configuration

The `build` block lives in `app/package.json` (small enough not to warrant a
separate `electron-builder.yml`):

- `appId: "org.agentseal.codeburn-desktop"` — reuses the `org.agentseal.*`
  prefix from the menubar app's bundle id (`org.agentseal.codeburn-menubar`,
  see `mac/Scripts/package-app.sh`); there is no `com.codeburn.*` bundle id
  anywhere in the codebase, so `org.agentseal.*` is the actual house
  convention.
- `productName: "CodeBurn"`.
- `files`: only `dist/electron/**/*`, `dist/renderer/**/*`, and `package.json`.
  The Electron main process has no npm runtime dependencies (only Node/Electron
  builtins — see `app/electron/cli.ts` and `app/electron/quota/*.ts`), and the
  renderer is a single Vite bundle, so the app's own `node_modules` does not
  need to ship at all. (The *bundled CLI* has its own `node_modules`, added to
  `Resources/cli/` by the `afterPack` hook — see "The bundled CLI" above.)
- `afterPack: "./scripts/after-pack.cjs"` — copies the staged CLI bundle
  (`app/build/cli`) into `Contents/Resources/cli` after packaging and before
  signing.
- `mac.identity: "-"` — forces ad-hoc signing. **`identity: null` does NOT
  ad-hoc sign — it skips signing entirely**, which produces a bundle with a
  broken/absent seal (`codesign --verify --deep --strict` fails with
  `code has no resources but signature indicates they must be present`, and
  Apple Silicon refuses to run it at all). `"-"` is the same ad-hoc identity
  `mac/Scripts/package-app.sh` uses for the menubar app's local/CI builds.
- `mac.hardenedRuntime: false` — hardened runtime is for notarized builds;
  leaving it on for an ad-hoc signature with no entitlements can prevent the
  app from launching.
- `mac.gatekeeperAssess: false` — skips electron-builder's post-sign
  `spctl` check, which would always fail for an unnotarized app.
- `icon: build/icon.png` — a pre-existing 1024x1024 PNG at
  `app/build/icon.png`. No `.icns` exists in the repo; electron-builder
  generates one from the PNG at build time. This is the same source PNG
  used for the app icon; the menubar app has its own separate icon
  (`assets/menubar-logo.png`, converted to `.icns` in `package-app.sh`).
- `directories.output: "release"` — electron-builder's default output dir is
  `dist`, which collides with this app's existing `tsc`/`vite` build output
  (`app/dist/electron`, `app/dist/renderer`) that `files` reads from. Using
  a separate `release/` directory keeps build inputs and packaging outputs apart.

## Windows and Linux builds

Both are cross-built from the same macOS host used for the mac build — no
Windows or Linux machine, and no `wine`, is required. electron-builder 26
embeds the Windows executable's icon/version resources natively and downloads
the NSIS and AppImage tooling on first run.

### Windows (`package:win`)

`electron-builder --win` produces a single artifact in `app/release/`:

- **`CodeBurn Setup 0.9.15.exe`** — the NSIS installer (the version number
  tracks `package.json`; note the spaces in the filename). A `.exe.blockmap`
  is written alongside it (differential-update metadata, unused — no
  auto-updater yet).

Config (`build.win` + `build.nsis`):

- `win.target: nsis`, `arch: x64`.
- `win.icon: build/icon.png` — electron-builder converts the 1024x1024 PNG to
  a multi-resolution `.ico` at build time (same source PNG as the mac icon).
- `nsis.oneClick: false` — an assisted installer with a wizard, so users get
  an **install-directory choice** instead of a silent one-click install.
- `nsis.perMachine: false` — installs per-user (into the user's `AppData`),
  so **no administrator/UAC elevation** is needed.

**The build is UNSIGNED** (no Authenticode certificate). electron-builder logs
`signing with signtool.exe`, but with no certificate configured that step is a
no-op — the `.exe` ships without a signature. On first run, Windows SmartScreen
shows **"Windows protected your PC"**. Users click **"More info" → "Run
anyway"** to launch it. This is expected for an unsigned build; the only fix is
a purchased code-signing (Authenticode/EV) certificate.

### Linux (`package:linux`)

`electron-builder --linux` produces a single artifact in `app/release/`:

- **`CodeBurn-0.9.15.AppImage`** — a self-contained AppImage (no install step,
  no package manager).

Config (`build.linux`):

- `linux.target: AppImage`, `arch: x64`.
- `linux.category: "Development"` — the freedesktop menu category.
- `linux.icon: build/icon.png` — reuses the same source PNG.
- `linux.maintainer: "AgentSeal <hello@agentseal.org>"` — matches the root
  `package.json` author.
- `linux.executableName: "codeburn"` — the binary name inside the AppImage
  (lowercase, no spaces), distinct from the `CodeBurn` product name.

After downloading, the AppImage must be made executable before it will run:

```sh
chmod +x CodeBurn-0.9.15.AppImage
./CodeBurn-0.9.15.AppImage
```

The build logs one benign warning — `desktopName is not set` — which only
affects how some desktop environments group the app's windows in the
taskbar/dock; it does not affect packaging or launch.

## Releases

There is no release CI for the desktop app yet (see the note at the top). When
a maintainer cuts a desktop release by hand, the GitHub tag convention is:

```
desktop-v<version>      # e.g. desktop-v0.9.15
```

This mirrors the menubar's `mac-v<version>` convention (see `../RELEASING.md`)
and keeps the desktop app's tags in their own namespace, separate from the CLI
(`v<version>`) and the menubar (`mac-v<version>`). Upload all of the artifacts
above — the four macOS `.dmg`/`.zip` files, `CodeBurn-Setup-<version>.exe`,
and `CodeBurn-<version>.AppImage` — to the GitHub Release created at that
tag. The website's download links **pin that tag** in their URLs, so the
release name and the artifact filenames must match exactly. (The Windows
installer uses an explicit `nsis.artifactName` of
`CodeBurn-Setup-${version}.${ext}` — electron-builder's default contains
spaces, which make ugly percent-encoded URLs.)

## Verifying a build

```sh
codesign -dv --verbose=2 app/release/mac-arm64/CodeBurn.app
codesign --verify --deep --strict app/release/mac-arm64/CodeBurn.app
```

Expect `Signature=adhoc`, a real `Identifier=org.agentseal.codeburn-desktop`,
and `Sealed Resources` present. The deep-verify command should exit 0.

To smoke-test that the packaged renderer actually loads (the classic failure
is a white screen from a wrong `loadFile` path once assets are behind
`app.asar`), launch the built binary directly and confirm the process tree
stays up and the main process logs no `did-fail-load` errors:

```sh
"app/release/mac-arm64/CodeBurn.app/Contents/MacOS/CodeBurn" --user-data-dir=/tmp/codeburn-smoke
```

A healthy launch spawns `CodeBurn`, `CodeBurn Helper` (gpu-process),
`CodeBurn Helper` (utility/network), and `CodeBurn Helper (Renderer)`
processes and keeps running with no stderr output. `main.ts`'s
`did-fail-load` handler (`console.error('Renderer failed to load ...')`)
prints to that same stderr if the packaged `loadFile(path.join(__dirname,
'..', 'renderer', 'index.html'))` path is ever wrong.

## The Gatekeeper story (no paid Apple Developer account)

Ad-hoc signing satisfies the *kernel's* code-signing requirement (Apple
Silicon refuses to execute anything with no signature at all), but it is not
a Developer ID signature and the app is not notarized. Concretely:

- `spctl --assess --type execute` on the built app returns **`rejected`**,
  ad-hoc-signed or not, quarantined or not. `spctl`'s static assessment
  checks for a Developer ID + notarization ticket, which this build does
  not have and cannot have without a paid account.
- Any file downloaded through a browser (or unzipped by Finder's Archive
  Utility from a browser download) gets a `com.apple.quarantine` extended
  attribute. The first time a quarantined, non-notarized app is opened,
  Gatekeeper blocks a plain double-click with "Apple could not verify that
  \[CodeBurn] is free of malware."
- **This is expected and correct for an unpaid, unnotarized build.** Being
  a known GitHub author, signing the repo's commits, or ad-hoc signing the
  binary does **not** change this — none of that is a substitute for an
  Apple-issued Developer ID certificate plus notarization.

### First-open instructions for users

**Field-verified on macOS 15+ (Sequoia/Tahoe): an ad-hoc-signed, quarantined
app gets the harsher "\[CodeBurn] is damaged and can't be opened. You should
move it to the Trash." dialog, and the classic right-click → Open bypass does
NOT work for it** (that trick only helps Developer-ID-signed, unnotarized
apps). The reliable path is stripping the quarantine attribute:

```sh
# after dragging CodeBurn.app from the dmg into /Applications
xattr -cr /Applications/CodeBurn.app
```

One time only; subsequent launches work normally. **System Settings →
Privacy & Security → "Open Anyway"** may also appear after a blocked attempt
and works when offered, but is not shown in all cases for ad-hoc builds —
document the `xattr` path as primary anywhere user-facing.

None of these steps are needed for a `dmg`/`zip` built and opened locally on
the same machine (no quarantine attribute is applied to files that were never
downloaded) — they only apply to a build distributed to someone else, e.g.
via a GitHub Release.

### Folder-access prompts re-appear on every update

CodeBurn requests access to folders like Documents, Desktop, and Downloads
(via `mac.extendInfo` in `app/package.json`) to read local AI coding tool
session logs. Because each ad-hoc/unsigned build has no stable Developer ID,
macOS TCC treats every rebuild as a new app identity, so users get
re-prompted for folder access after each update even though nothing else
changed. Signing with a stable Developer ID certificate (see "Upgrade path"
below) fixes this — TCC grants persist across updates once the app's
identity is stable.

## Upgrade path: paid account + notarization

When a paid Apple Developer Program membership is available, the same
`electron-builder` config takes the upgrade with a few changes, no new
tooling:

- Set `mac.identity` to the real `"Developer ID Application: <Name> (<TEAMID>)"`
  certificate name (or let electron-builder auto-discover it from the
  keychain by removing `identity` entirely), and set `mac.hardenedRuntime:
  true` with an entitlements file.
- Add a `notarize` block (or the `afterSign` hook electron-builder's
  `@electron/notarize` integration expects) with an app-specific password or
  API key, and remove `gatekeeperAssess: false` so electron-builder verifies
  the notarized result itself.
- Everything else — `appId`, `files`, `mac.target` (dmg/zip, arm64+x64),
  `icon`, `directories.output` — stays as-is.
