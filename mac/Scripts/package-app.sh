#!/usr/bin/env bash
# Builds a universal CodeBurnMenubar.app bundle from the SwiftPM target and drops a
# distributable zip alongside. Used by the GitHub release workflow; also runnable locally.
#
# Usage:
#   mac/Scripts/package-app.sh [<version>]
# Defaults to `dev` if no version is given.

set -euo pipefail

VERSION="${1:-dev}"
# Refuse anything outside the strict tag charset before interpolating into the Info.plist
# heredoc. Tag pushes are constrained by git's own rules (no <, >, ", newlines), but the
# workflow's workflow_dispatch.inputs.version accepts arbitrary text -- a manual run with
# 'dev</string><string>injected' would emit an XML-broken Info.plist. The regex matches the
# semver-ish charset we actually use (digits, dots, letters, hyphens, underscores).
if [[ ! "${VERSION}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Refusing to package: VERSION '${VERSION}' contains characters outside [A-Za-z0-9._-]" >&2
  exit 1
fi
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
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
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

# Prefer a Developer ID identity when the release workflow has imported one into the
# keychain and exported its common name as DEVELOPER_ID_SIGNING_IDENTITY. Falls back to
# ad-hoc so local `mac/Scripts/package-app.sh` runs still work without an Apple cert.
# Developer ID signing is a prerequisite for notarisation (which happens in the workflow
# after this script returns).
SIGN_IDENTITY="${DEVELOPER_ID_SIGNING_IDENTITY:-}"
if [[ -n "${SIGN_IDENTITY}" ]]; then
  echo "▸ Signing with Developer ID: ${SIGN_IDENTITY}"
  codesign --force --sign "${SIGN_IDENTITY}" --timestamp --options runtime --deep "${BUNDLE}"
  codesign --verify --deep --strict --verbose=2 "${BUNDLE}"
else
  echo "▸ Ad-hoc signing (DEVELOPER_ID_SIGNING_IDENTITY unset)..."
  # Let real codesign failures surface (previously `|| true` swallowed them, so a local
  # build with a malformed SwiftPM output would ship a silently unsigned bundle).
  codesign --force --sign - --timestamp=none --deep "${BUNDLE}"
  codesign --verify --deep --strict "${BUNDLE}" 2>/dev/null || echo "  (signature verify skipped)"
fi

ZIP_NAME="CodeBurnMenubar-${VERSION}.zip"
ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"
echo "▸ Packaging ${ZIP_NAME}..."
(cd "${DIST_DIR}" && /usr/bin/ditto -c -k --keepParent "${BUNDLE_NAME}" "${ZIP_NAME}")

echo ""
echo "✓ Built ${ZIP_PATH}"
ls -la "${DIST_DIR}"
