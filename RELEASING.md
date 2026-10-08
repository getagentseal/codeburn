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

### 3. GitHub Actions Builds, Signs, and Notarizes the Bundle

The `.github/workflows/release-menubar.yml` workflow runs on the `mac-v*` tag and:

1. Fails right away if any signing secret below is missing. It never publishes an ad-hoc build.
2. Imports the Developer ID Application certificate into a temporary keychain.
3. Runs `mac/Scripts/package-app.sh v0.9.8`, which builds the universal app, signs it with hardened runtime and a secure timestamp, notarizes it with `notarytool` using the App Store Connect API key, staples the ticket, then zips it to `CodeBurnMenubar-v0.9.8.zip` and writes `CodeBurnMenubar-v0.9.8.zip.sha256`.
4. Unzips the result and checks it the way the installer will: checksum, `codesign --verify --strict` against team `XRVP7P7F9M`, and `spctl --assess`.
5. Uploads both files to a GitHub Release named "Menubar v0.9.8".
6. Downloads the published zip, confirms it matches the verified build, and only then rewrites `menubar-latest.json` on the `update-feeds` prerelease (see below).

No manual re-signing, notarizing, or re-uploading is needed. The repository secrets it needs are listed under "Secrets" below.

To build a signed release locally, run `package-app.sh` with `CODESIGN_IDENTITY`, `NOTARY_KEY_PATH`, `NOTARY_KEY_ID` and `NOTARY_ISSUER_ID` set.

### 4. Verify the Release

After the workflow completes, the GitHub Release page shows the zip and sha256 files, and the `update-feeds` prerelease carries a `menubar-latest.json` naming the new version. `codeburn menubar --force` installs the `mac-v*` release matching the CLI version. When that is missing, it reads the feed, and if the feed is unavailable it scans recent `mac-v*` releases. It refuses any bundle that fails the checksum, bundle id, Developer ID team (`XRVP7P7F9M`) or Gatekeeper check.

## Homebrew Core

CodeBurn is in homebrew-core. After publishing a new CLI version to npm, the homebrew-core formula is updated automatically by Homebrew's bot or can be bumped manually:

```bash
brew bump-formula-pr codeburn --url "https://registry.npmjs.org/codeburn/-/codeburn-<VERSION>.tgz"
```

Users install with `brew install codeburn` and upgrade with `brew upgrade codeburn`.

## Update Feeds

GitHub's "Latest release" is whichever line (`v*`, `mac-v*`, `desktop-v*`, `windows-v*`) was published last, so nothing should read `/releases/latest`. Update clients read fixed files on the rolling `update-feeds` prerelease instead, at `https://github.com/getagentseal/codeburn/releases/download/update-feeds/<file>`:

- `menubar-latest.json`: `{"version": "0.9.8", "url": "<zip download url>", "sha256": "<zip sha256>"}`. The menubar's update check and `codeburn menubar` read it. Written by `release-menubar.yml`.
- `latest-mac.yml`, `latest-linux.yml` and `latest.yml`: the desktop app (electron-updater). Written by the `publish-update-feeds` job in `build-windows-installer.yml`.
- `windows-latest.json`: the Windows tray (tauri-plugin-updater). Written by `release-menubar-windows.yml`.

`update-feeds` holds only metadata; the files point at the versioned `mac-v*`, `desktop-v*` and `windows-v*` releases that hold the downloads. Whichever workflow runs first creates it with the same flags (`--prerelease --latest=false`, title "Update feeds"), and each workflow replaces only its own files with `gh release upload --clobber`. Keep it a prerelease, never mark it Latest, and never edit it by hand except to roll back.

## Desktop and tray auto-update

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

## Secrets

Repository secrets (Settings > Secrets and variables > Actions). All are set today.

| Secret | Used by | What it holds |
| --- | --- | --- |
| `MACOS_CERT_P12_BASE64` | `release-menubar.yml`, `build-desktop-mac.yml` | The "Developer ID Application: Resham Joshi (XRVP7P7F9M)" certificate and private key, exported as .p12, base64 encoded (`base64 -i cert.p12`) |
| `MACOS_CERT_PASSWORD` | `release-menubar.yml`, `build-desktop-mac.yml` | The password the .p12 was exported with |
| `MACOS_KEYCHAIN_PASSWORD` | `release-menubar.yml` | Any random string; it locks the throwaway CI keychain |
| `APPSTORE_API_KEY_P8_BASE64` | `release-menubar.yml`, `build-desktop-mac.yml` | The App Store Connect API key (`AuthKey_<id>.p8`, Developer role or higher), base64 encoded, for notarization |
| `APPSTORE_API_KEY_ID` | `release-menubar.yml`, `build-desktop-mac.yml` | That key's Key ID |
| `APPSTORE_API_ISSUER_ID` | `release-menubar.yml`, `build-desktop-mac.yml` | The Issuer ID shown above the key list in App Store Connect |
| `TAURI_SIGNING_PRIVATE_KEY` | `release-menubar-windows.yml` | Tray updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `release-menubar-windows.yml` | Its password |

Without the macOS secrets the menubar release and `Build macOS desktop` fail; the manual signed desktop build in `app/DISTRIBUTION.md` still works, but it must build both arches in one `electron-builder --mac` run so one `latest-mac.yml` lists both zips.

The tray key's public half is `plugins.updater.pubkey` in `windows/src-tauri/tauri.conf.json`. To rotate it, run `npx @tauri-apps/cli signer generate -w ~/.tauri/codeburn-tray.key`, then replace the two secrets and the pubkey in one go: a private key without its matching pubkey fails the tray build. Losing the private key means every installed tray needs a manual update to a build with a new key. Without the secret the workflow builds the MSI with `npm run tauri build -- --no-sign` and leaves `windows-latest.json` alone, so trays keep their release-page link. That step runs under `shell: bash`; PowerShell drops the `--` and the flag never reaches the Tauri CLI.

## Never Replace Assets on an Existing Release

Do not re-upload or `--clobber` assets on a published `v*`, `mac-v*`, `desktop-v*` or `windows-v*` release. Installed copies, checksums and the feeds already point at them: the feeds carry each file's sha256 (menubar), sha512 (desktop) or signature (tray), so a replaced file fails verification on every client. If a build is broken, cut a new patch release instead. The only release whose files change is `update-feeds`: CI writes it, and a rollback (below) restores it by hand.

## Rollback

If a released version has a critical bug, the fastest path is to fix the bug and cut a new patch release (e.g., 0.9.8 -> 0.9.9). Delete the broken tag locally and on GitHub if it has not yet been widely distributed:

```bash
git tag -d v0.9.8
git push origin --delete v0.9.8
```

npm does not allow republishing to the same version. If you must unpublish from npm, use `npm unpublish codeburn@0.9.8 --force` (requires Owner role), but this is discouraged and all users who installed that version retain it.

For the menubar, tag a new mac-v0.9.9 and let the workflow build and upload it; the feed moves to it when the workflow finishes. Users see the update pill and upgrade from it (or manually via `codeburn menubar --force`).

To stop a bad menubar release from spreading before the fix is out, point the feed back at the previous good release:

```bash
gh release download update-feeds -p menubar-latest.json -O /tmp/menubar-latest.json
# set version, url and sha256 back to the previous mac-v release (sha256 is in its .zip.sha256)
gh release upload update-feeds /tmp/menubar-latest.json --clobber
```

That stops the update pill from offering the bad version. A CLI at the bad version still installs its matching `mac-v*` release, so the real fix is still the new patch release.

## Summary

The CLI release is manual: bump the version, update `CHANGELOG.md`, commit, run `npm publish`, then tag and create a GitHub Release. The macOS menubar release is automated: pushing a `mac-v*` tag fires `.github/workflows/release-menubar.yml`, which builds, signs with Developer ID, notarizes, staples, zips, publishes the bundle, and then moves the `update-feeds` pointer. The Electron desktop release is assembled manually under a `desktop-v*` tag, with the release-authoritative Windows NSIS installer built by the read-only `windows-latest` workflow. The homebrew-core formula is updated automatically or via `brew bump-formula-pr`.
