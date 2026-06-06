#!/usr/bin/env bash
# Build and install a local CodeBurn CLI tarball, then launch the menubar app
# built from this checkout. Useful when upstream macOS releases lag behind a
# fork/branch you want to test.

set -euo pipefail

REPLACE_APP=0
SYSTEM_APP=0
MIN_NODE_VERSION="22.13.0"

usage() {
  cat <<'USAGE'
Usage:
  npm run local:mac:menubar -- [--replace-app] [--system-app]

Options:
  --replace-app  Replace the installed app with the locally built app before launching.
  --system-app   Install to /Applications/CodeBurnMenubar.app instead of ~/Applications/CodeBurnMenubar.app.
  -h, --help     Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --replace-app)
      REPLACE_APP=1
      shift
      ;;
    --system-app)
      SYSTEM_APP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd)
}

require_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node ${MIN_NODE_VERSION}+ is required, but node was not found." >&2
    exit 1
  fi

  local node_version
  node_version="$(node -p "process.versions.node")"
  if ! node -e "
const current = process.versions.node.split('.').map(Number)
const minimum = '${MIN_NODE_VERSION}'.split('.').map(Number)
const ok = current[0] > minimum[0]
  || (current[0] === minimum[0] && current[1] > minimum[1])
  || (current[0] === minimum[0] && current[1] === minimum[1] && current[2] >= minimum[2])
process.exit(ok ? 0 : 1)
"; then
    echo "Node ${MIN_NODE_VERSION}+ is required, but found ${node_version}." >&2
    exit 1
  fi
}

ROOT="$(repo_root)"
PACK_DIR="${TMPDIR:-/tmp}/codeburn-local-pack"
SUPPORT_DIR="${HOME}/Library/Application Support/CodeBurn"
WRAPPER_PATH="${SUPPORT_DIR}/codeburn-menubar-cli"
PERSISTED_CLI_PATH="${SUPPORT_DIR}/codeburn-cli-path.v1"
if [[ "${SYSTEM_APP}" -eq 1 ]]; then
  INSTALLED_APP_PATH="/Applications/CodeBurnMenubar.app"
else
  INSTALLED_APP_PATH="${HOME}/Applications/CodeBurnMenubar.app"
fi

cd "${ROOT}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for the macOS menubar app." >&2
  exit 1
fi

require_node_version

echo "==> Building CLI"
npm run build
NODE_PATH="$(node -p "process.execPath")"
if [[ ! -x "${NODE_PATH}" ]]; then
  echo "Node executable was not found at ${NODE_PATH}." >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "${NODE_PATH}")"

echo "==> Packing CLI"
rm -rf "${PACK_DIR}"
mkdir -p "${PACK_DIR}"
TARBALL_NAME="$(npm pack --silent --pack-destination "${PACK_DIR}")"
TARBALL_PATH="${PACK_DIR}/${TARBALL_NAME}"

echo "==> Installing global CLI from ${TARBALL_PATH}"
npm install -g "${TARBALL_PATH}"

CLI_PATH="$(command -v codeburn || true)"
if [[ -z "${CLI_PATH}" ]]; then
  echo "Global codeburn command was not found after npm install -g." >&2
  exit 1
fi

echo "==> Writing menubar CLI wrapper"
mkdir -p "${SUPPORT_DIR}"
{
  printf '%s\n' '#!/bin/sh'
  printf 'export PATH=%s:"${PATH:-}"\n' "$(printf '%q' "${NODE_BIN_DIR}")"
  printf 'exec %s "$@"\n' "$(printf '%q' "${CLI_PATH}")"
} > "${WRAPPER_PATH}"
chmod 755 "${WRAPPER_PATH}"

echo "==> Persisting CLI path: ${WRAPPER_PATH}"
printf '%s\n' "${WRAPPER_PATH}" > "${PERSISTED_CLI_PATH}"
chmod 600 "${PERSISTED_CLI_PATH}"

VERSION="$(node -p "require('./package.json').version")-local"
echo "==> Building menubar app (${VERSION})"
mac/Scripts/package-app.sh "v${VERSION}"

APP_PATH="${ROOT}/mac/.build/dist/CodeBurnMenubar.app"
if [[ ! -d "${APP_PATH}" ]]; then
  echo "Menubar app was not built at ${APP_PATH}" >&2
  exit 1
fi

if [[ "${REPLACE_APP}" -eq 1 ]]; then
  echo "==> Replacing ${INSTALLED_APP_PATH}"
  pkill -f CodeBurnMenubar 2>/dev/null || true
  if [[ "${SYSTEM_APP}" -eq 1 ]]; then
    sudo mkdir -p "$(dirname "${INSTALLED_APP_PATH}")"
    sudo rm -rf "${INSTALLED_APP_PATH}"
    sudo cp -R "${APP_PATH}" "${INSTALLED_APP_PATH}"
    sudo chown -R root:wheel "${INSTALLED_APP_PATH}"
  else
    mkdir -p "$(dirname "${INSTALLED_APP_PATH}")"
    rm -rf "${INSTALLED_APP_PATH}"
    cp -R "${APP_PATH}" "${INSTALLED_APP_PATH}"
  fi
  APP_PATH="${INSTALLED_APP_PATH}"
fi

echo "==> Restarting menubar app"
pkill -f CodeBurnMenubar 2>/dev/null || true
open "${APP_PATH}"

echo ""
echo "Ready."
echo "CLI: ${CLI_PATH}"
echo "App: ${APP_PATH}"
