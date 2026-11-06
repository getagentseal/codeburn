#!/bin/bash
set -euo pipefail

UUID="codeburn@codeburn.dev"
INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing CodeBurn GNOME extension..."

# Compile GSettings schema
echo "Compiling schemas..."
glib-compile-schemas "${SCRIPT_DIR}/schemas/"

# Create install directory
mkdir -p "${INSTALL_DIR}"

# Copy extension files
cp "${SCRIPT_DIR}/metadata.json" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/extension.js" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/indicator.js" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/dataClient.js" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/refreshCadence.js" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/prefs.js" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/stylesheet.css" "${INSTALL_DIR}/"

# Copy schemas
mkdir -p "${INSTALL_DIR}/schemas"
cp "${SCRIPT_DIR}/schemas/"* "${INSTALL_DIR}/schemas/"

# Copy icons
mkdir -p "${INSTALL_DIR}/icons"
cp "${SCRIPT_DIR}/icons/"* "${INSTALL_DIR}/icons/"

echo "Extension installed to ${INSTALL_DIR}"
echo ""
echo "Next steps:"
echo "  1. Restart GNOME Shell (log out and back in on Wayland)"
echo "  2. Enable: gnome-extensions enable ${UUID}"
echo "  3. Configure: gnome-extensions prefs ${UUID}"
