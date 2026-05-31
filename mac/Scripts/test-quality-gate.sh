#!/usr/bin/env bash
# mac/scripts/test-quality-gate.sh
#
# Quality gate for CodeBurnMenubar (macOS SwiftUI app).
# Runs two test tiers:
#   1. Unit + ViewInspector tests (swift test) — fast, no app launch
#   2. XCUITest end-to-end tests (xcodebuild) — launches real app
#
# Usage:
#   mac/scripts/test-quality-gate.sh          # both tiers
#   mac/scripts/test-quality-gate.sh unit     # tier 1 only (CI default)
#   mac/scripts/test-quality-gate.sh ui       # tier 2 only (local/nightly)
#
# Prerequisites:
#   - Xcode 16+ (swift, xcodebuild)
#   - xcodegen (brew install xcodegen) — only for tier 2
#
# Note: The GIT_CONFIG_COUNT override works around enterprise git policies
# that block SwiftPM's bare-repository package caching.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${MAC_DIR}"

TIER="${1:-all}"
FAILED=0

# ─── Tier 1: Unit + ViewInspector (swift test) ────────────────────────────────

run_unit_tests() {
    echo "━━━ Tier 1: Unit + ViewInspector tests (swift test) ━━━"
    if GIT_CONFIG_COUNT=0 swift test --parallel 2>&1; then
        echo "✅ Tier 1 passed"
    else
        echo "❌ Tier 1 FAILED"
        FAILED=1
    fi
    echo ""
}

# ─── Tier 2: XCUITest (xcodebuild) ───────────────────────────────────────────

run_ui_tests() {
    echo "━━━ Tier 2: XCUITest end-to-end (xcodebuild) ━━━"

    if ! command -v xcodegen &>/dev/null; then
        echo "⚠️  xcodegen not found — install with: brew install xcodegen"
        echo "⚠️  Skipping tier 2"
        return
    fi

    echo "▸ Generating Xcode project..."
    xcodegen generate --quiet 2>/dev/null || xcodegen generate

    echo "▸ Running UI tests..."
    if xcodebuild test \
        -project CodeBurnMenubar.xcodeproj \
        -scheme CodeBurnMenubarUITests \
        -destination 'platform=macOS' \
        -quiet \
        2>&1 | tail -20; then
        echo "✅ Tier 2 passed"
    else
        echo "❌ Tier 2 FAILED"
        FAILED=1
    fi
    echo ""
}

# ─── Dispatch ─────────────────────────────────────────────────────────────────

case "${TIER}" in
    unit|1)
        run_unit_tests
        ;;
    ui|2|e2e)
        run_ui_tests
        ;;
    all|*)
        run_unit_tests
        run_ui_tests
        ;;
esac

if [[ ${FAILED} -ne 0 ]]; then
    echo "🚨 Quality gate FAILED"
    exit 1
fi

echo "🎉 Quality gate passed"
