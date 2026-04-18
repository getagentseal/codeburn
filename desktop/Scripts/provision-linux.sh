#!/usr/bin/env bash
# One-shot Ubuntu provisioning for the CodeBurn desktop (Tauri) dev environment.
#
# Usage inside a fresh Ubuntu 24.04 LTS Server VM (after `sudo apt install
# ubuntu-desktop-minimal && sudo reboot`, and logging into GNOME):
#
#   curl -fsSL https://raw.githubusercontent.com/getagentseal/codeburn/feat/tauri-menubar-win-linux/desktop/Scripts/provision-linux.sh | bash
#
# Or if you cloned the repo manually: `bash desktop/Scripts/provision-linux.sh`.
#
# Installs: build toolchain, webkit + appindicator headers, Node 20 LTS, Rust stable,
# the codeburn npm CLI, and this repo. Leaves you one command away from `npm run tauri dev`.

set -euo pipefail

REPO_URL="https://github.com/getagentseal/codeburn.git"
BRANCH="feat/tauri-menubar-win-linux"
CHECKOUT="${HOME}/codeburn"

log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Platform sanity
[[ "$(uname -s)" == "Linux" ]] || fail "Run me on Linux (detected: $(uname -s))."
if ! command -v apt-get >/dev/null; then
  fail "Only apt-based distros supported by this provisioner (Ubuntu, Debian)."
fi

log "apt update + system build deps"
sudo apt-get update -qq
sudo apt-get install -y \
  build-essential curl wget file git \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  libgtk-3-dev \
  pkg-config

# 2. Node 20 LTS via NodeSource if the distro version is too old. Tauri CLI needs >= 18.
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]]; then
  log "installing Node 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 3. Rust via rustup if not present
if ! command -v cargo >/dev/null; then
  log "installing Rust via rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

# 4. codeburn CLI (the Tauri app shells out to this for data)
if ! command -v codeburn >/dev/null; then
  log "installing codeburn CLI from npm"
  sudo npm install -g codeburn
fi

# 5. Repo
if [[ -d "${CHECKOUT}/.git" ]]; then
  log "updating existing checkout at ${CHECKOUT}"
  git -C "${CHECKOUT}" fetch origin
  git -C "${CHECKOUT}" checkout "${BRANCH}"
  git -C "${CHECKOUT}" pull --ff-only origin "${BRANCH}"
else
  log "cloning ${REPO_URL} into ${CHECKOUT}"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${CHECKOUT}"
fi

# 6. npm deps for the desktop app
log "npm install for desktop/"
(cd "${CHECKOUT}/desktop" && npm install --no-audit --no-fund)

# 7. Summary + next step
cat <<EOF

\033[1;32m✓\033[0m Provisioning complete.

Next:

  cd ${CHECKOUT}/desktop
  npm run tauri dev

A flame tray icon should appear in your panel. Click it for the popover. Hot reload is
wired for the React code; Rust changes need a rebuild.
EOF
