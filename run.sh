#!/usr/bin/env bash
#
# CodeBurn quickstart (v2.0.1, Auggie-only fork)
# =============================================
# Edit the values below, then:   ./run.sh
# Or override inline:             BILLING_MODE=token_plus ./run.sh
# ---------------------------------------------------------------

set -euo pipefail

# ---- Billing mode -----------------------------------------
# "credits"    = Augment credits (default, ground-truth via BILLING_METADATA)
# "token_plus" = USD estimate (synthesized, not invoice-accurate)
: "${BILLING_MODE:=credits}"

# ---- Surcharge (token_plus mode only) ---------------------
# 0     = Self-serve CBP / no surcharge (default)
# 0.3   = Enterprise USD with contracted 30% surcharge
# Decimal only. Ignored in credits mode.
: "${SURCHARGE_RATE:=0}"

# ---- Period -----------------------------------------------
# today | yesterday | week | month | 30days | all
: "${PERIOD:=today}"

# ---- Output format ----------------------------------------
# terminal = interactive TUI dashboard (default)
# json     = machine-readable JSON blob
: "${FORMAT:=terminal}"

# ---- Optional: override Augment data dir ------------------
# Default is ~/.augment; uncomment to change.
# : "${AUGMENT_HOME:=$HOME/.augment-work}"

# ---- Optional: skip rebuild if dist/ is fresh -------------
# 0 = always rebuild, 1 = only build if dist/cli.js missing
: "${SKIP_BUILD_IF_FRESH:=1}"

# ---------------------------------------------------------------
# Implementation below — no user configuration needed past here
# ---------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

err() { echo -e "${RED}✗ $*${NC}" >&2; }
ok()  { echo -e "${GREEN}✓ $*${NC}"; }
info() { echo -e "${CYAN}$*${NC}"; }

# JSON parsing helper (uses jq if available, falls back to node)
json_get() {
  local json="$1" path="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r "$path"
  else
    echo "$json" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try { const o=JSON.parse(d); const v=eval('o'+process.argv[1].replace(/^\./,''));
        console.log(v===null?'null':v===undefined?'undefined':v); }
        catch(e){ console.log('ERROR'); }
      });" "$path"
  fi
}

# ---------------------------------------------------------------
# --check mode: UI/UX sanity checks
# ---------------------------------------------------------------
if [[ "${1:-}" == "--check" ]]; then
  echo -e "${BOLD}CodeBurn UI/UX sanity checks${NC}"
  echo "==============================="
  FAILURES=0

  # Ensure build exists
  if [[ ! -f dist/cli.js ]]; then
    info "Building first..."
    npm install --silent
    npm run build
  fi

  # Check 1: credits mode
  echo -e "\n${CYAN}[1/5] Credits mode...${NC}"
  OUTPUT=$(CODEBURN_BILLING_MODE=credits node dist/cli.js today --format json 2>/dev/null || true)
  MODE=$(json_get "$OUTPUT" '.billing.mode')
  COST=$(json_get "$OUTPUT" '.overview.cost')
  CREDITS=$(json_get "$OUTPUT" '.overview.creditsAugment')
  
  if [[ "$MODE" == "credits" ]]; then ok "billing.mode == credits"; else err "billing.mode != credits (got: $MODE)"; ((FAILURES++)); fi
  if [[ "$COST" == "null" ]]; then ok "overview.cost == null"; else err "overview.cost != null (got: $COST)"; ((FAILURES++)); fi
  if [[ "$CREDITS" =~ ^[0-9]+(\.[0-9]+)?$ || "$CREDITS" == "null" ]]; then ok "overview.creditsAugment is number or null"; else err "overview.creditsAugment invalid (got: $CREDITS)"; ((FAILURES++)); fi

  # Check 2: token_plus mode, 0% surcharge
  echo -e "\n${CYAN}[2/5] Token_plus mode (0% surcharge)...${NC}"
  OUTPUT=$(CODEBURN_BILLING_MODE=token_plus CODEBURN_SURCHARGE_RATE=0 node dist/cli.js today --format json 2>/dev/null || true)
  MODE=$(json_get "$OUTPUT" '.billing.mode')
  SURCHARGE=$(json_get "$OUTPUT" '.billing.surchargeRate')
  COST=$(json_get "$OUTPUT" '.overview.cost')
  CREDITS=$(json_get "$OUTPUT" '.overview.creditsAugment')
  
  if [[ "$MODE" == "token_plus" ]]; then ok "billing.mode == token_plus"; else err "billing.mode != token_plus (got: $MODE)"; ((FAILURES++)); fi
  if [[ "$SURCHARGE" == "0" ]]; then ok "billing.surchargeRate == 0"; else err "billing.surchargeRate != 0 (got: $SURCHARGE)"; ((FAILURES++)); fi
  if [[ "$COST" =~ ^[0-9]+(\.[0-9]+)?$ || "$COST" == "null" ]]; then ok "overview.cost is number or null"; else err "overview.cost invalid (got: $COST)"; ((FAILURES++)); fi
  if [[ "$CREDITS" == "null" ]]; then ok "overview.creditsAugment == null"; else err "overview.creditsAugment != null (got: $CREDITS)"; ((FAILURES++)); fi

  # Check 3: token_plus mode, 30% surcharge
  echo -e "\n${CYAN}[3/5] Token_plus mode (30% surcharge)...${NC}"
  OUTPUT=$(CODEBURN_BILLING_MODE=token_plus CODEBURN_SURCHARGE_RATE=0.3 node dist/cli.js today --format json 2>/dev/null || true)
  SURCHARGE=$(json_get "$OUTPUT" '.billing.surchargeRate')
  
  if [[ "$SURCHARGE" == "0.3" ]]; then ok "billing.surchargeRate == 0.3"; else err "billing.surchargeRate != 0.3 (got: $SURCHARGE)"; ((FAILURES++)); fi

  # Check 4: No legacy macOS app references in --help (removed in 2.0.1)
  FORBIDDEN_TERM="menu""bar"  # split to avoid self-match
  echo -e "\n${CYAN}[4/5] No legacy app references...${NC}"
  HELP_OUTPUT=$(node dist/cli.js --help 2>&1 || true)
  if echo "$HELP_OUTPUT" | grep -qi "$FORBIDDEN_TERM"; then
    err "Found legacy app reference in --help output"
    ((FAILURES++))
  else
    ok "No legacy app references in --help"
  fi

  # Check 5: Main script has no legacy app references (excluding this check block)
  echo -e "\n${CYAN}[5/5] Main code has no legacy app references...${NC}"
  # Count matches, excluding the check block itself (grep -c returns count per line)
  MATCH_COUNT=$(grep -c "$FORBIDDEN_TERM" "$0" 2>/dev/null || echo "0")
  MATCH_COUNT=$(echo "$MATCH_COUNT" | head -1 | tr -d '[:space:]')
  # The only matches should be in this check block itself (3 occurrences)
  if [[ "$MATCH_COUNT" -gt 3 ]]; then
    err "Found legacy app references outside check block"
    ((FAILURES++))
  else
    ok "No legacy app references in main code"
  fi

  echo ""
  if [[ $FAILURES -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All checks passed!${NC}"
    exit 0
  else
    echo -e "${RED}${BOLD}$FAILURES check(s) failed${NC}"
    exit 1
  fi
fi

# ---------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------

# Check Node.js version (need >= 22)
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js >= 22: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  err "Node.js $NODE_VERSION found, but >= 22 required."
  echo "  Install a newer version: https://nodejs.org/ or use nvm/fnm"
  exit 1
fi

# Check npm
if ! command -v npm &>/dev/null; then
  err "npm not found. Install npm (comes with Node.js)."
  exit 1
fi

# Check Augment sessions directory
AUGMENT_DIR="${AUGMENT_HOME:-$HOME/.augment}"
SESSIONS_DIR="$AUGMENT_DIR/sessions"

if [[ ! -d "$SESSIONS_DIR" ]]; then
  err "No Auggie sessions found at $SESSIONS_DIR"
  echo "  Run 'auggie login' and have at least one conversation first."
  exit 1
fi

SESSION_COUNT=$(find "$SESSIONS_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SESSION_COUNT" -eq 0 ]]; then
  err "No session files in $SESSIONS_DIR"
  echo "  Have at least one Auggie conversation to generate session data."
  exit 1
fi

# ---------------------------------------------------------------
# Build step
# ---------------------------------------------------------------

needs_build() {
  # Always need build if dist/cli.js doesn't exist
  [[ ! -f dist/cli.js ]] && return 0

  # Skip build check if SKIP_BUILD_IF_FRESH=0
  [[ "$SKIP_BUILD_IF_FRESH" == "0" ]] && return 0

  # Check if any src file is newer than dist/cli.js
  local newest_src
  newest_src=$(find src -type f -newer dist/cli.js 2>/dev/null | head -1)
  [[ -n "$newest_src" ]] && return 0

  return 1
}

if needs_build; then
  info "Building CodeBurn..." >&2
  if [[ -d node_modules ]]; then
    npm install --silent 2>&1 >&2 || npm install >&2
  else
    npm install >&2
  fi
  npm run build >&2
else
  ok "dist/ is up to date; skipping build" >&2
fi

# ---------------------------------------------------------------
# Info banner (sent to stderr so JSON output on stdout is clean)
# ---------------------------------------------------------------

# Build mode display string
if [[ "$BILLING_MODE" == "token_plus" ]]; then
  if [[ "$SURCHARGE_RATE" != "0" ]]; then
    MODE_DISPLAY="USD estimate (token_plus, surcharge ${SURCHARGE_RATE}x)"
  else
    MODE_DISPLAY="USD estimate (token_plus)"
  fi
else
  MODE_DISPLAY="credits"
fi

{
  echo ""
  echo -e "${BOLD}CodeBurn 2.0.1${NC} (Auggie-only fork)"
  echo -e "  Mode:     ${CYAN}$MODE_DISPLAY${NC}"
  echo -e "  Period:   ${CYAN}$PERIOD${NC}"
  echo -e "  Format:   ${CYAN}$FORMAT${NC}"
  echo -e "  Sessions: ${CYAN}$SESSION_COUNT files${NC} in $SESSIONS_DIR"
  echo -e "${YELLOW}Tips:${NC}"
  echo "  Switch mode:   BILLING_MODE=token_plus ./run.sh"
  echo "  JSON export:   FORMAT=json ./run.sh | jq '.billing'"
  echo "  Find waste:    node dist/cli.js optimize"
  echo "  Change ccy:    node dist/cli.js currency GBP"
  echo "  Cache:         ~/.cache/codeburn/ (rm -rf to reset)"
  echo ""
} >&2

# ---------------------------------------------------------------
# Execute CLI
# ---------------------------------------------------------------

export CODEBURN_BILLING_MODE="$BILLING_MODE"
export CODEBURN_SURCHARGE_RATE="$SURCHARGE_RATE"

# Build command arguments
CMD_ARGS=()

case "$PERIOD" in
  today)
    CMD_ARGS+=("today")
    ;;
  yesterday)
    # Cross-platform date handling: macOS uses -v, Linux uses -d
    if date -v-1d +%Y-%m-%d &>/dev/null; then
      YESTERDAY=$(date -v-1d +%Y-%m-%d)
    else
      YESTERDAY=$(date -d "yesterday" +%Y-%m-%d)
    fi
    CMD_ARGS+=("report" "--from" "$YESTERDAY" "--to" "$YESTERDAY")
    ;;
  month)
    CMD_ARGS+=("month")
    ;;
  week|30days|all)
    CMD_ARGS+=("report" "--period" "$PERIOD")
    ;;
  *)
    CMD_ARGS+=("today")
    ;;
esac

if [[ "$FORMAT" == "json" ]]; then
  CMD_ARGS+=("--format" "json")
fi

exec node dist/cli.js "${CMD_ARGS[@]}"
