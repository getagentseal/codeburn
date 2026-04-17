# CodeBurn Security Audit Report

**Date:** 2026-04-15
**Scope:** Full source code review for external data transmission
**Verdict:** No user data is leaked. Two outbound read-only HTTP requests exist for reference data only.

---

## Executive Summary

CodeBurn reads local AI coding session files, calculates token costs locally, and displays results in the terminal. It does not transmit session data, token counts, cost figures, project names, or any user-identifiable information to any external system.

Two outbound network requests exist, both fetching publicly available reference data. Neither sends user data in the request.

---

## Findings

### Finding 1 -- LiteLLM Model Pricing Fetch

- **File:** `src/models.ts`, line 22 and lines 69-87
- **URL:** `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- **Direction:** Read-only GET request
- **Data sent:** None (no query parameters, no request body, no headers with user data)
- **Data received:** JSON file with AI model pricing per token
- **Frequency:** Once per 24 hours, cached locally at `~/.cache/codeburn/litellm-pricing.json`
- **Fallback:** Hardcoded pricing table used if the request fails (lines 26-45)
- **Risk:** LOW -- This is a static JSON file hosted on GitHub. No user data leaves the machine.

### Finding 2 -- Frankfurter Currency Exchange Rate Fetch

- **File:** `src/currency.ts`, line 14 and lines 54-60
- **URL:** `https://api.frankfurter.app/latest?from=USD&to={CODE}`
- **Direction:** Read-only GET request
- **Data sent:** Only the target currency code in the URL (e.g., `?to=BRL`)
- **Data received:** JSON exchange rate for that currency pair
- **Frequency:** Once per 24 hours, cached locally at `~/.cache/codeburn/exchange-rate.json`
- **Fallback:** Returns rate of 1.0 if the request fails (line 91)
- **Risk:** LOW -- The only variable in the request is a standard ISO currency code. No user data is transmitted.

---

## What Was Verified Clean

| Area | Result |
| ------ | -------- |
| Session data (tokens, costs, projects) | Never transmitted. Processed entirely in memory. |
| npm scripts (build, dev, test, prepublishOnly) | All local. No postinstall hooks or phone-home scripts. |
| Dependencies (chalk, commander, ink, react) | UI/CLI only. No networking libraries. |
| Optional deps (better-sqlite3) | Local SQLite reader for Cursor DB. No network use. |
| Telemetry/analytics | None. No Sentry, DataDog, Segment, or similar. |
| Cloud SDKs | None. No AWS, GCP, or Azure packages. |
| Environment variables | Only `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` -- all for local path resolution. |
| Export commands (CSV/JSON) | Write to user-specified local paths only. |
| Config storage | `~/.config/codeburn/config.json` stores only currency preference locally. |
| eval / dynamic code execution | None. |
| Process spawning | None for network purposes. |

---

## Dependency Inventory

**Production (4):** chalk, commander, ink, react
**Optional (1):** better-sqlite3
**Dev-only (5):** @types/better-sqlite3, @types/react, tsup, tsx, typescript, vitest

None of these dependencies include built-in telemetry or analytics collection.

---

## Recommendations

1. **No immediate action required.** The two outbound requests fetch public reference data and do not leak user information.

2. **Optional hardening -- offline mode.** If fully air-gapped operation is desired, the fallback pricing and a fixed exchange rate already work when the network is unavailable. A `--offline` flag could be added to skip fetch attempts entirely.

3. **Optional hardening -- pin external URLs.** The LiteLLM URL points to a `main` branch raw file that could change upstream. Pinning to a specific commit hash would prevent unexpected content changes.

4. **Dependency auditing.** Run `npm audit` periodically. The current dependency set is minimal and low-risk, but transitive dependencies should be monitored.
