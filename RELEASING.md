# Releasing CodeBurn

This document describes the actual steps a maintainer takes to cut CLI, macOS menubar, and Electron desktop releases. CLI releases are run by hand with `npm publish`; macOS menubar releases are automated by `.github/workflows/release-menubar.yml` when a `mac-v*` tag is pushed.

The Electron desktop app (`app/`) is released manually under `desktop-v<version>` tags. The tag runs two read-only workflows: `Build macOS desktop` (signed, notarized dmgs and zips plus `latest-mac.yml`, artifact `CodeBurn-macOS`) and `Build Windows installer` on `windows-latest` (artifact `CodeBurn-Windows-Installer`). Build Linux artifacts as described in `app/DISTRIBUTION.md`. Upload the artifacts' files, the Linux files and `latest-linux.yml` to the release. Neither workflow publishes release assets.

Before announcing a desktop release, the release owner must confirm the live GitHub Release contains all four macOS `.dmg`/`.zip` files, the Linux `.AppImage`, `.deb`, and `.rpm`, both Windows installer files, `latest-mac.yml` and `latest-linux.yml`. Publishing the Release runs the workflow's read-only live-asset verification job. If assets are uploaded after publication, rerun `Build Windows installer` with the `release_tag` input and require that verification job to pass. A failed or missing verification is a release blocker. Only after it passes does the `publish-update-feeds` job point the desktop update feed at the release (see "Desktop and tray auto-update").

## Versioning

CodeBurn uses semantic versioning (major.minor.patch). The CLI and macOS menubar share the same version number for clarity.

## Before Every Release

The authoritative acceptance process lives in [`docs/release-acceptance/README.md`](docs/release-acceptance/README.md). Start a new evidence directory and run the exact candidate through the automated gate:

```bash
node scripts/release-acceptance/run.mjs --mode package --output /absolute/path/to/evidence/run-id
```

For a major release or material parser/cache/UI change, complete every blocking row in `docs/release-acceptance/cases.csv`, append the reviewed result to `docs/release-acceptance/ledger/history.jsonl`, and require installed-artifact click-through on every shipped surface. The automated runner does not replace Desktop, Menu Bar, or browser interaction.

Run the test suite to catch any regressions:

```bash
npm test
npm run test:locks
```

`npm test` covers `tests/`. `npm run test:locks` runs the three parallelism-sensitive
`cache-refresh-lock` suites serially; CI treats them as reporting-only, so check them by
hand here.

Verify that the build completes without errors:

```bash
npm run build
```

## CLI Release Process

### 1. Update the Version

Edit `package.json` to bump the version number. Update both the `version` field at the top and the `package-lock.json` lockfile to match (npm handles this automatically):

```bash
npm version <version>
```

For example, `npm version 0.9.8` updates both files and creates a commit.

Alternatively, edit `package.json` by hand and run `npm install` to regenerate the lockfile with the new version.

### 2. Update the Changelog

Edit `CHANGELOG.md`. Move all changes from the "Unreleased" section into a new section with the version number and today's date:

```markdown
## Unreleased

### ...

## 0.9.8 - 2026-05-10

### Added
- Feature X

### Fixed
- Bug Y
```

Commit these changes:

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore: bump to 0.9.8"
```

### 3. Publish to npm

There is no GitHub Actions workflow for the CLI; the maintainer runs `npm publish` from a clean working tree:

```bash
npm publish
```

The `prepublishOnly` script in `package.json` runs `npm run build` first, which bundles the litellm pricing snapshot and then runs `tsup` to emit `dist/cli.js`.

If publishing for the first time on a new machine, run `npm login` first.

### 4. Tag the Release

After npm accepts the publish, tag the commit and push:

```bash
git tag v0.9.8
git push origin v0.9.8
```

The tag is for human reference and to anchor the GitHub Release. No workflow runs on `v*` tags for the CLI today.

### 5. Verify npm Publication

```bash
npm view codeburn version
```

### 5b. Bump the Homebrew Tap

The tap at `getagentseal/homebrew-codeburn` does not update itself — bump it
every CLI release or it drifts (issue #716 sat six versions behind):

```bash
curl -sLO "https://registry.npmjs.org/codeburn/-/codeburn-<version>.tgz"
shasum -a 256 codeburn-<version>.tgz
# edit Formula/codeburn.rb in the tap: url version + sha256, commit, push
```

### 6. Create a GitHub Release

Use the GitHub CLI to create a release with notes from the changelog:

```bash
gh release create v0.9.8 --title v0.9.8 --notes "$(sed -n '/^## 0.9.8/,/^## /p' CHANGELOG.md | head -n -1)"
```

Or use the web interface to draft a release and copy the changelog section into the body.

## macOS Menubar Release Process

The macOS menubar is released separately with its own GitHub Release, but shares the same version number as the CLI.

### 1. Same Version Bump

Follow the same version bumping process as the CLI. Both `package.json` and `CHANGELOG.md` reflect the shared version.

### 2. Tag the macOS Release

After the CLI tag is published, create a separate tag for the menubar:

```bash
git tag mac-v0.9.8
git push origin mac-v0.9.8
```

### 3. GitHub Actions Builds the Bundle

The `.github/workflows/release-menubar.yml` workflow automatically detects the `mac-v*` tag and:

1. Checks out the repo
2. Runs `mac/Scripts/package-app.sh v0.9.8`
3. Signs the app bundle with the Developer ID Application certificate, notarizes it with Apple, and staples the ticket
4. Creates a zip file: `CodeBurnMenubar-v0.9.8.zip`
5. Computes a SHA-256 checksum: `CodeBurnMenubar-v0.9.8.zip.sha256`
6. Uploads both to a GitHub Release named "Menubar v0.9.8"

The script output on the build machine shows:

```
✓ Built /path/mac/.build/dist/CodeBurnMenubar-v0.9.8.zip
✓ Checksum /path/mac/.build/dist/CodeBurnMenubar-v0.9.8.zip.sha256
<sha256-hash>  CodeBurnMenubar-v0.9.8.zip
```

No manual action is needed; the workflow handles everything.

### 4. Verify the Release

After the workflow completes, the GitHub Release page shows the zip and sha256 files. The installed CLI command `codeburn menubar --force` fetches the newest `mac-v*` menubar release that includes both assets, verifies the checksum and bundle identity, and installs it into `~/Applications`.

## Homebrew Core

CodeBurn is in homebrew-core. After publishing a new CLI version to npm, the homebrew-core formula is updated automatically by Homebrew's bot or can be bumped manually:

```bash
brew bump-formula-pr codeburn --url "https://registry.npmjs.org/codeburn/-/codeburn-<VERSION>.tgz"
```

Users install with `brew install codeburn` and upgrade with `brew upgrade codeburn`.

## Desktop and tray auto-update

The desktop app (electron-updater) and the Windows tray (tauri-plugin-updater) read their update metadata from one rolling prerelease, `update-feeds`, at fixed URLs:

- `https://github.com/getagentseal/codeburn/releases/download/update-feeds/latest-mac.yml`, `latest-linux.yml` and `latest.yml` (desktop)
- `https://github.com/getagentseal/codeburn/releases/download/update-feeds/windows-latest.json` (tray)

`update-feeds` is never marked Latest, holds only metadata, and is the one release whose assets are replaced (`gh release upload --clobber`). The metadata points at the versioned `desktop-v*` / `windows-v*` releases, which hold the installers.

### Secrets

| Secret | Used by | What it is |
| --- | --- | --- |
| `MACOS_CERT_P12_BASE64` | `build-desktop-mac.yml` | Developer ID Application certificate + key, `.p12`, base64 |
| `MACOS_CERT_PASSWORD` | `build-desktop-mac.yml` | Password of that `.p12` |
| `APPSTORE_API_KEY_P8_BASE64` | `build-desktop-mac.yml` | App Store Connect API key (`.p8`), base64, for notarization |
| `APPSTORE_API_KEY_ID` | `build-desktop-mac.yml` | Key ID of that API key |
| `APPSTORE_API_ISSUER_ID` | `build-desktop-mac.yml` | Issuer ID of that API key |
| `TAURI_SIGNING_PRIVATE_KEY` | `release-menubar-windows.yml` | Tray updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `release-menubar-windows.yml` | Its password |

The macOS names match the menubar release workflow. Generate the tray key pair once with `npx @tauri-apps/cli signer generate -w ~/.tauri/codeburn-tray.key`, store the private key and password as the two secrets, and replace `REPLACE_WITH_TAURI_UPDATER_PUBKEY` in `windows/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) with the public key. Until that commit ships, the tray keeps its release-page link. Losing the private key means every installed tray needs a manual update to a build with a new key.

### Feed upload order

Feeds go up last, only after every asset they reference is live:

1. Desktop: upload all assets to the `desktop-v<version>` release and publish it. `verify-release-assets` checks the asset list; then `publish-update-feeds` downloads the release's `latest*.yml`, rewrites their file names to absolute `desktop-v<version>` URLs (`app/scripts/update-feed.mjs`, which fails on any file the release lacks), refuses to move the feed to an older version, and uploads them to `update-feeds`.
2. Tray: `release-menubar-windows.yml` signs the MSI, creates the `windows-v<version>` release, confirms the MSI is on it, then writes `windows-latest.json` (version, minisign signature, MSI URL) and uploads it to `update-feeds`.

To hold an update back, do not publish the release (desktop) or do not push the tag (tray).

### Windows NSIS auto-update

Off. The switch is `WINDOWS_AUTO_UPDATE` in `app/electron/auto-update.ts`; with it `false`, Windows keeps the link banner and `latest.yml` on the feed is ignored. Before turning it on, pick one:

- **A, Authenticode.** Buy a code-signing certificate, sign the NSIS installer in `build-windows-installer.yml` (`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`), and set `build.win.signtoolOptions.publisherName` in `app/package.json`. electron-updater then refuses any installer not signed by that publisher. SmartScreen stops warning too.
- **B, hash only.** No certificate. electron-updater checks the installer against the sha512 in `latest.yml`, which proves the download is intact, not who built it: anyone who can write to the release and the feed can ship code. SmartScreen keeps warning on first install.

Then set the constant to `true`, rebuild, and add `latest.yml` to the required list in `app/scripts/verify-windows-installer.mjs`.

## Replacing Assets on an Existing Release

Never replace assets on a `desktop-v*` or `windows-v*` release. The feeds on `update-feeds` carry each file's sha512 (desktop) or signature (tray), so a replaced installer fails verification on every client. Cut a new patch version instead. `--clobber` is for `update-feeds` only.

For the macOS menubar (`mac-v*`), if a release is published with broken assets (e.g., a menubar zip with a build error), re-run the build and upload the fixed assets without creating a new tag.

Use `gh release upload` with the `--clobber` flag to overwrite existing files:

```bash
# After re-running mac/Scripts/package-app.sh v0.9.8 to regenerate the zip and sha256
gh release upload mac-v0.9.8 mac/.build/dist/CodeBurnMenubar-v0.9.8.zip --clobber
gh release upload mac-v0.9.8 mac/.build/dist/CodeBurnMenubar-v0.9.8.zip.sha256 --clobber
```

The GitHub Release page will now serve the fixed assets. The menubar installer selects the newest `mac-v*` release with `CodeBurnMenubar-v*.zip` plus its checksum, so users who run `codeburn menubar --force` after the replacement get the fixed version automatically.

## Rollback

If a released version has a critical bug, the fastest path is to fix the bug and cut a new patch release (e.g., 0.9.8 -> 0.9.9). Delete the broken tag locally and on GitHub if it has not yet been widely distributed:

```bash
git tag -d v0.9.8
git push origin --delete v0.9.8
```

npm does not allow republishing to the same version. If you must unpublish from npm, use `npm unpublish codeburn@0.9.8 --force` (requires Owner role), but this is discouraged and all users who installed that version retain it.

For the menubar, tag a new mac-v0.9.9 and let the workflow build and upload it. Users will see the update pill in the menubar settings and upgrade automatically (or manually via `codeburn menubar --force`).

## Summary

The CLI release is manual: bump the version, update `CHANGELOG.md`, commit, run `npm publish`, then tag and create a GitHub Release. The macOS menubar release is automated: pushing a `mac-v*` tag fires `.github/workflows/release-menubar.yml`, which builds, signs, zips, and publishes the bundle. The Electron desktop release is assembled manually under a `desktop-v*` tag, with the release-authoritative Windows NSIS installer built by the read-only `windows-latest` workflow. The homebrew-core formula is updated automatically or via `brew bump-formula-pr`.
