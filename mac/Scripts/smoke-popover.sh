#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="${1:-/tmp/codeburn-menubar-smoke-$(date +%Y%m%d-%H%M%S)}"
TMP_CLI_DIR="$(mktemp -d /tmp/codeburn-cli.XXXXXX)"

cleanup() {
  rm -rf "$TMP_CLI_DIR"
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"

if [[ ! -x "$ROOT_DIR/dist/cli.js" ]]; then
  (cd "$ROOT_DIR" && npm run build)
fi

ln -sf "$ROOT_DIR/dist/cli.js" "$TMP_CLI_DIR/cli.js"

(
  cd "$ROOT_DIR/mac"
  CODEBURN_ALLOW_DEV_BIN=1 \
  CODEBURN_BIN="node $TMP_CLI_DIR/cli.js" \
  CODEBURN_MENUBAR_SMOKE_OUTPUT="$OUT_DIR" \
  swift run
)

echo "Smoke report: $OUT_DIR/report.json"
