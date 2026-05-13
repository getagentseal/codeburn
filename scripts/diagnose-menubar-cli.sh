#!/bin/bash
# Replicates the menubar's restricted PATH environment to test if the CLI
# can find and run codeburn with the same PATH the menubar provides.
#
# The menubar augments PATH with: /opt/homebrew/bin /usr/local/bin
# The base PATH for a Login Item is typically: /usr/bin:/bin:/usr/sbin:/sbin

set -euo pipefail

RESTRICTED_PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"

echo "=== Menubar PATH Diagnostic ==="
echo ""
echo "Using restricted PATH: $RESTRICTED_PATH"
echo ""

# 1. Check if codeburn is found
echo "--- Step 1: Locate codeburn binary ---"
FOUND=$(PATH="$RESTRICTED_PATH" /usr/bin/env which codeburn 2>&1 || true)
if [ -z "$FOUND" ]; then
    echo "FAIL: codeburn not found in restricted PATH"
    echo ""
    echo "Where codeburn actually is:"
    /usr/bin/env which -a codeburn 2>/dev/null || echo "(not found anywhere)"
    echo ""
    echo "Fix: codeburn is installed outside the menubar's PATH. Options:"
    echo "  1. Add the install directory to CodeburnCLI.additionalPathEntries"
    echo "  2. Symlink codeburn into /usr/local/bin"
    exit 1
fi
echo "OK: codeburn found at: $FOUND"
echo ""

# 2. Check if node is found (needed for codeburn shell wrapper)
echo "--- Step 2: Locate node binary ---"
NODE_FOUND=$(PATH="$RESTRICTED_PATH" /usr/bin/env which node 2>&1 || true)
if [ -z "$NODE_FOUND" ]; then
    echo "WARNING: node not found in restricted PATH"
    echo "This may cause codeburn to fail if it's a shell wrapper."
    echo ""
else
    echo "OK: node found at: $NODE_FOUND"
    echo "Node version: $(PATH="$RESTRICTED_PATH" node --version 2>&1 || echo 'failed')"
fi
echo ""

# 3. Run the command the menubar spawns
echo "--- Step 3: Run menubar-equivalent CLI command ---"
echo "Command: codeburn status --format menubar-json --period today --provider all"
echo ""

STDERR_FILE=$(mktemp)
trap 'rm -f "$STDERR_FILE"' EXIT

if PATH="$RESTRICTED_PATH" /usr/bin/env -- codeburn status --format menubar-json --period today --provider all 2>"$STDERR_FILE"; then
    echo ""
    if [ -s "$STDERR_FILE" ]; then
        echo "Warnings/errors on stderr:"
        cat "$STDERR_FILE"
    fi
    echo ""
    echo "SUCCESS: CLI ran successfully with restricted PATH."
else
    EXIT_CODE=$?
    echo ""
    echo "FAIL: CLI exited with code $EXIT_CODE"
    if [ -s "$STDERR_FILE" ]; then
        echo ""
        echo "Stderr output:"
        cat "$STDERR_FILE"
    fi
    exit 1
fi
