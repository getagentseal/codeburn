#!/usr/bin/env bash
# ============================================================================
# build-local.sh — Build CodeBurnMenubar.app on a macOS 14 (Sonoma) machine.
# ============================================================================
# Why this exists
# ---------------
# The released .app is built in CI with the macOS 15 SDK + Swift 6. That binary
# hard-links /usr/lib/swift/libswift_errno.dylib, which only ships in macOS 15,
# so `codeburn menubar` fails on Sonoma with:
#     kLSIncompatibleSystemVersionErr (-10825)
#
# This script builds an arm64 bundle locally against the machine's macOS 14 SDK
# (no libswift_errno dependency, minos = 14.0) using a swift.org Swift 6.2
# toolchain. Because the macOS 14 SDK's SwiftUI does NOT carry the @MainActor
# annotations that the macOS 15 SDK added to the `View` protocol, the sources
# are copied to a scratch dir and every `View`/`App` struct is given an explicit
# `@MainActor` there — the repo sources stay untouched.
#
# Prerequisites
#   - Command Line Tools (provides the macOS 14 SDK + sips/iconutil/codesign)
#   - A swift.org Swift 6.x toolchain in ~/Library/Developer/Toolchains/
#       download: https://www.swift.org/install/macos/  (Swift 6.2 recommended)
#
# Usage: mac/Scripts/build-local.sh [<version>]   (defaults to "dev")
# ----------------------------------------------------------------------------
set -euo pipefail

VERSION="${1:-dev}"
BUNDLE_ID="org.agentseal.codeburn-menubar"
EXE="CodeBurnMenubar"
MIN_MACOS="14.0"

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MAC_DIR="${ROOT}/mac"
ICON_SOURCE="${ROOT}/assets/menubar-logo.png"
SCRATCH="$(mktemp -d /tmp/codeburn-local-build.XXXXXX)"
APPS="${HOME}/Applications"
BUNDLE="${APPS}/${EXE}.app"

trap 'rm -rf "${SCRATCH}"' EXIT

# --- locate a Swift 6.x toolchain -------------------------------------------
TC=""
for cand in "${HOME}/Library/Developer/Toolchains/swift-6.2-RELEASE.xctoolchain" \
            "${HOME}/Library/Developer/Toolchains/swift-latest.xctoolchain" \
            /Library/Developer/Toolchains/swift-latest.xctoolchain; do
  [[ -x "${cand}/usr/bin/swift" ]] && { TC="${cand}"; break; }
done
if [[ -z "${TC}" ]]; then
  echo "✗ No swift.org Swift 6.x toolchain found in ~/Library/Developer/Toolchains/." >&2
  echo "  Install one from https://www.swift.org/install/macos/ (Swift 6.2)." >&2
  exit 1
fi
SWIFT="${TC}/usr/bin/swift"
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
echo "▸ Toolchain : $("${SWIFT}" --version | head -1)"
echo "▸ SDK       : ${SDKROOT} ($(xcrun --sdk macosx --show-sdk-version))"

# --- copy sources and add explicit @MainActor to SwiftUI views --------------
echo "▸ Staging sources in ${SCRATCH}..."
# Tests/ is copied only so the manifest's testTarget path resolves; `swift build`
# (product only) never compiles it, so it needs no @MainActor patching.
cp -R "${MAC_DIR}/Sources" "${MAC_DIR}/Tests" "${MAC_DIR}/Package.swift" "${SCRATCH}/"
find "${SCRATCH}/Sources" -name "*.swift" -print0 | while IFS= read -r -d '' f; do
  perl -i -pe 's/^((?:private |public |fileprivate )?struct \b.*: .*\bView\b.*\{)/\@MainActor\n$1/; s/^(struct \w+ *: *App\b.*\{)/\@MainActor\n$1/' "$f"
  perl -0777 -i -pe 's/\@MainActor\n\@MainActor\n/\@MainActor\n/g' "$f"
done

# --- build arm64 release (single-arch avoids xcbuild, absent from CLT) -------
echo "▸ Building arm64 release..."
( cd "${SCRATCH}" && "${SWIFT}" build -c release )
BIN="$(cd "${SCRATCH}" && "${SWIFT}" build -c release --show-bin-path)/${EXE}"
[[ -x "${BIN}" ]] || { echo "✗ build produced no binary" >&2; exit 1; }

# --- assemble the .app bundle ------------------------------------------------
echo "▸ Assembling ${BUNDLE}..."
pkill -f "${EXE}" 2>/dev/null || true; sleep 1
rm -rf "${BUNDLE}"
mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources"
cp "${BIN}" "${BUNDLE}/Contents/MacOS/${EXE}"
cp "${ICON_SOURCE}" "${BUNDLE}/Contents/Resources/menubar-logo.png"

ICONSET="${SCRATCH}/AppIcon.iconset"; mkdir -p "${ICONSET}"
for spec in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" "128:128x128" \
            "256:128x128@2x" "256:256x256" "512:256x256@2x" "512:512x512"; do
  sips -z "${spec%%:*}" "${spec%%:*}" "${ICON_SOURCE}" --out "${ICONSET}/icon_${spec##*:}.png" >/dev/null
done
cp "${ICON_SOURCE}" "${ICONSET}/icon_512x512@2x.png"
iconutil -c icns "${ICONSET}" -o "${BUNDLE}/Contents/Resources/AppIcon.icns"

cat > "${BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleDisplayName</key><string>CodeBurn Menubar</string>
    <key>CFBundleExecutable</key><string>${EXE}</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>${EXE}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>© AgentSeal</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "${BUNDLE}/Contents/PkgInfo"

echo "▸ Ad-hoc signing..."
codesign --force --sign - --timestamp=none --deep "${BUNDLE}"
codesign --verify --deep --strict "${BUNDLE}"

echo ""
echo "✓ Installed ${BUNDLE}"
vtool -show-build "${BUNDLE}/Contents/MacOS/${EXE}" 2>/dev/null | grep -iE "minos|sdk" | sed 's/^/  /'
echo "  Launch with: codeburn menubar   (or: open '${BUNDLE}')"
