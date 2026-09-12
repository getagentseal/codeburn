#!/usr/bin/env bash
# ============================================================================
# build-local.sh, Build CodeBurnMenubar.app on a macOS 14 (Sonoma) machine.
# ============================================================================
# Why this exists
# ---------------
# Package.swift's `.macOS(.v14)` deployment target already fixes the -10825
# launch failure for every build, including the CI-distributed release: ld64
# drops the macOS-15-only libswift_errno.dylib dependency based on the
# deployment target, not the SDK used to build. This script is not about that.
#
# It exists for the narrower case of building on a Sonoma machine that only
# has the Command Line Tools (macOS 14 SDK). That SDK's SwiftUI does NOT carry
# the @MainActor annotations the macOS 15 SDK added to the `View` protocol, so
# a plain `swift build` there fails with ~80 `main actor-isolated ... from a
# nonisolated context` errors. This script copies the sources to a scratch
# dir, gives every `View`/`App` conformance an explicit `@MainActor` there
# (repo sources stay untouched), and builds a universal bundle with a
# swift.org Swift 6.2 toolchain against the local macOS 14 SDK.
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

# --- toolchain + SDK selection ----------------------------------------------
# Two supported configurations:
#   1. Full Xcode installed, use its SDK. REQUIRED on macOS 15+ SDKs, where
#      SwiftUI's @State is a macro whose plugin (libSwiftUIMacros.dylib) ships
#      ONLY inside Xcode. The Command Line Tools do not carry it, so a CLT-only
#      build of any SwiftUI view fails with "external macro implementation type
#      'SwiftUIMacros.StateMacro' could not be found".
#   2. Command Line Tools with the macOS 14 SDK plus a swift.org toolchain.
#      That SDK's SwiftUI lacks the @MainActor annotations later SDKs added,
#      which is what the source patching below exists for.
SWIFT=""
for cand in "${HOME}/Library/Developer/Toolchains/swift-6.2-RELEASE.xctoolchain" \
            "${HOME}/Library/Developer/Toolchains/swift-latest.xctoolchain" \
            /Library/Developer/Toolchains/swift-latest.xctoolchain; do
  [[ -x "${cand}/usr/bin/swift" ]] && { SWIFT="${cand}/usr/bin/swift"; break; }
done
[[ -n "${SWIFT}" ]] || SWIFT="$(command -v swift || true)"
if [[ -z "${SWIFT}" ]]; then
  echo "✗ No swift compiler found (no swift.org toolchain, no swift on PATH)." >&2
  exit 1
fi

# Prefer Xcode's SDK when present: its SwiftUI and its macro plugins are a
# matched pair. Mixing an Xcode plugin with a CLT SDK expands @State into
# calls the SDK does not declare (e.g. State._makeStorage_v0).
XCODE_SDK="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
if [[ -d "${XCODE_SDK}" ]]; then
  export SDKROOT="${XCODE_SDK}"
else
  export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
fi
SDK_VERSION="$(plutil -extract Version raw "${SDKROOT}/SDKSettings.plist" 2>/dev/null \
               || xcrun --sdk macosx --show-sdk-version)"

PATCH_MAINACTOR=0
case "${SDK_VERSION}" in
  14.*) PATCH_MAINACTOR=1 ;;
  *)
    if [[ ! -d "/Applications/Xcode.app" ]]; then
      echo "✗ Active SDK is macOS ${SDK_VERSION}, whose SwiftUI needs a macro" >&2
      echo "  plugin that only full Xcode ships. Install Xcode:" >&2
      echo "    mas install 497799835" >&2
      echo "  or point xcode-select at a macOS 14 SDK for the legacy path." >&2
      exit 1
    fi
    ;;
esac
echo "▸ Toolchain : $("${SWIFT}" --version | head -1)"
echo "▸ SDK       : ${SDKROOT} (${SDK_VERSION})"

# --- copy sources and add explicit @MainActor to SwiftUI views --------------
echo "▸ Staging sources in ${SCRATCH}..."
# Tests/ is copied only so the manifest's testTarget path resolves; `swift build`
# (product only) never compiles it, so it needs no @MainActor patching.
cp -R "${MAC_DIR}/Sources" "${MAC_DIR}/Tests" "${MAC_DIR}/Package.swift" "${SCRATCH}/"
if (( PATCH_MAINACTOR )); then
find "${SCRATCH}/Sources" -name "*.swift" -print0 | while IFS= read -r -d '' f; do
  # Slurp mode ([^{]* spans newlines) so this also catches multi-line generic
  # struct headers and `extension X: View` conformances, not just the
  # single-line `struct X: View {` shape the current sources happen to use.
  perl -0777 -i -pe '
    s/^((?:private |public |fileprivate |internal )?(?:struct|extension)\s+\w+(?:<[^{]*?>)?\s*:[^{]*\bView\b[^{]*\{)/\@MainActor\n$1/gm;
    s/^(struct\s+\w+\s*:[^{]*\bApp\b[^{]*\{)/\@MainActor\n$1/gm;
    s/\@MainActor\n\@MainActor\n/\@MainActor\n/g;
  ' "$f"
done
else
  echo "▸ SDK ${SDK_VERSION} already annotates SwiftUI, skipping @MainActor patch."
fi

# --- build one universal binary ---------------------------------------------
# A single two-arch invocation goes through xcbuild and already emits a fat
# binary, so there is nothing left for lipo to merge.
echo "▸ Building universal release..."
( cd "${SCRATCH}" && "${SWIFT}" build -c release --arch arm64 --arch x86_64 )
PRODUCTS="$(cd "${SCRATCH}" && "${SWIFT}" build -c release --arch arm64 --arch x86_64 --show-bin-path)"
BIN="${PRODUCTS}/${EXE}"
[[ -x "${BIN}" ]] || { echo "✗ build produced no binary at ${BIN}" >&2; exit 1; }

# --- assemble the .app bundle ------------------------------------------------
echo "▸ Assembling ${BUNDLE}..."
pkill -x "${EXE}" 2>/dev/null || true; sleep 1
rm -rf "${BUNDLE}"
mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources"
cp "${BIN}" "${BUNDLE}/Contents/MacOS/${EXE}"
cp "${ICON_SOURCE}" "${BUNDLE}/Contents/Resources/menubar-logo.png"

# SwiftPM emits target resources as a separate .bundle that Bundle.module
# resolves from the app's Resources dir. Without it the app dies immediately
# with "unable to find bundle named CodeBurnMenubar_CodeBurnMenubar".
for rb in "${PRODUCTS}"/*.bundle; do
  [[ -d "${rb}" ]] && cp -R "${rb}" "${BUNDLE}/Contents/Resources/"
done

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
lipo -info "${BUNDLE}/Contents/MacOS/${EXE}" | sed 's/^/  /'
vtool -show-build "${BUNDLE}/Contents/MacOS/${EXE}" 2>/dev/null | grep -iE "minos|sdk" | sed 's/^/  /'
echo "  Launch with: codeburn menubar   (or: open '${BUNDLE}')"
