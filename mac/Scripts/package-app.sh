#!/usr/bin/env bash
# Builds a universal CodeBurnMenubar.app bundle from the SwiftPM target and drops a
# distributable zip alongside. Used by the GitHub release workflow; also runnable locally.
#
# Usage:
#   mac/Scripts/package-app.sh [<version>]
# Defaults to `dev` if no version is given.

set -euo pipefail

VERSION="${1:-dev}"
ASSET_VERSION="${VERSION#mac-}"
BUNDLE_VERSION="${ASSET_VERSION#v}"
BUNDLE_NAME="CodeBurnMenubar.app"
BUNDLE_ID="org.agentseal.codeburn-menubar"
EXECUTABLE_NAME="CodeBurnMenubar"
MIN_MACOS="14.0"

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd)
}

ROOT=$(repo_root)
MAC_DIR="${ROOT}/mac"
DIST_DIR="${MAC_DIR}/.build/dist"

cd "${MAC_DIR}"

echo "▸ Cleaning previous dist..."
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

echo "▸ Building universal binary (arm64 + x86_64)..."
swift build -c release --arch arm64 --arch x86_64

BIN_PATH=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)
BUILT_BINARY="${BIN_PATH}/${EXECUTABLE_NAME}"
if [[ ! -x "${BUILT_BINARY}" ]]; then
  echo "Binary not found at ${BUILT_BINARY}" >&2
  exit 1
fi

echo "▸ Assembling ${BUNDLE_NAME}..."
BUNDLE="${DIST_DIR}/${BUNDLE_NAME}"
mkdir -p "${BUNDLE}/Contents/MacOS"
mkdir -p "${BUNDLE}/Contents/Resources"
cp "${BUILT_BINARY}" "${BUNDLE}/Contents/MacOS/${EXECUTABLE_NAME}"

cat > "${BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>CodeBurn Menubar</string>
    <key>CFBundleExecutable</key>
    <string>${EXECUTABLE_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${EXECUTABLE_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${BUNDLE_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${BUNDLE_VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>© AgentSeal</string>
</dict>
</plist>
PLIST

cat > "${BUNDLE}/Contents/PkgInfo" <<'PKG'
APPL????
PKG

# Sign so macOS treats the bundle as internally consistent. Set CODESIGN_IDENTITY
# to a stable identity (Developer ID Application for distribution, or an Apple
# Development cert for local testing) so the TCC "access data from other apps"
# grant persists across rebuilds. Falls back to ad-hoc when unset (e.g. CI), which
# re-prompts on every build because each ad-hoc build has a fresh code identity.
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-}"
if [[ -n "${CODESIGN_IDENTITY}" ]]; then
  echo "▸ Signing with identity: ${CODESIGN_IDENTITY}"
  codesign --force --sign "${CODESIGN_IDENTITY}" --options runtime --timestamp=none --deep "${BUNDLE}"
else
  echo "▸ Ad-hoc signing (set CODESIGN_IDENTITY for a persistent TCC grant)..."
  codesign --force --sign - --timestamp=none --deep "${BUNDLE}"
fi
codesign --verify --deep --strict "${BUNDLE}"

ZIP_NAME="CodeBurnMenubar-${ASSET_VERSION}.zip"
ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"
echo "▸ Packaging ${ZIP_NAME}..."
(cd "${DIST_DIR}" && COPYFILE_DISABLE=1 /usr/bin/ditto -c -k --norsrc --keepParent "${BUNDLE_NAME}" "${ZIP_NAME}")

CHECKSUM_NAME="${ZIP_NAME}.sha256"
CHECKSUM_PATH="${DIST_DIR}/${CHECKSUM_NAME}"
echo "▸ Computing SHA-256 checksum..."
(cd "${DIST_DIR}" && shasum -a 256 "${ZIP_NAME}" > "${CHECKSUM_NAME}")

echo ""
echo "✓ Built ${ZIP_PATH}"
echo "✓ Checksum ${CHECKSUM_PATH}"
cat "${CHECKSUM_PATH}"
ls -la "${DIST_DIR}"
