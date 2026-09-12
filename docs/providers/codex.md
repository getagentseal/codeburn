# Codex

OpenAI Codex CLI.

- **Source:** `src/providers/codex.ts`
- **Loading:** eager (`src/providers/index.ts:2`)
- **Test:** `tests/providers/codex.test.ts` (1075 lines)

## Where it reads from

`$CODEX_HOME` if set, otherwise `~/.codex`. Active sessions are nested by date:

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
```

Archived sessions are stored in a flat directory and are included in usage reports:

```
~/.codex/archived_sessions/rollout-*.jsonl
```

The active-session discovery walk uses strict regex (`^\d{4}$`, `^\d{2}$`) on each path component.

## Storage format

JSONL. Validation of the first line is **structural**: it must parse as JSON, have `type === "session_meta"`, and carry a `payload` that is a plain object (not missing, not a scalar, not an array). Files that fail this check are silently skipped.

`payload.originator` is deliberately **not** part of the check. It is a free-form client identity string, not a format marker: Codex CLI writes `codex-tui` / `codex_exec` / `codex_cli_rs`, Codex Desktop writes `Codex Desktop`, and third-party frontends driving `codex app-server` write their own values (`t3code_desktop`, `JetBrains.IntelliJ IDEA`, ...) into structurally identical rollouts. Gating discovery on the spelling silently dropped those sessions from every report and required a new allowlist entry per client (issues #626, #873). Directory ownership decides the provider instead: `codex.ts` is the only provider that reads `~/.codex`, and the walk only visits `rollout-*.jsonl` under the strict `YYYY/MM/DD` path or `archived_sessions/`. `originator` is still parsed into the session meta entry, but nothing downstream reads it.

Because admission no longer implies a known client, every payload field is treated as untrusted JSON. `payload.cwd` in particular is type-guarded before it reaches `sanitizeProject` (discovery) or `projectPath`/`workingDirectory` (parse): a non-string `cwd` falls back to the `unknown` project instead of throwing out of `discoverSessions`, which `safeDiscoverSessions` would have turned into an empty session list for the *entire* provider.

The first line read is capped at 1 MB (`FIRST_LINE_READ_CAP`). Codex CLI 0.128+ embeds the full system prompt in `session_meta`, which can run 20-27 KB; the cap leaves headroom while bounding memory if a corrupt file has no newline.

## Caching

`src/codex-cache.ts` writes `~/.cache/codeburn/codex-results.v<n>.json` (or `$CODEBURN_CACHE_DIR/codex-results.v<n>.json`). The unsuffixed `codex-results.json` is left for older binaries; a matching-version copy is adopted once and never overwritten. Each entry is keyed by absolute file path and validated against `mtimeMs + sizeBytes`. Cached entries are returned wholesale.

A session that yielded zero parseable lines does **not** write to the cache (`codex.ts:419`); this prevents a transient read failure from pinning an empty result against a fingerprint.

## Deduplication

`codex:<sessionId>:<timestamp>:<cumulativeTotal>` for accounted events, plus `codex:<sessionId>:<timestamp>:est<n>` for estimated events that fall back to char-counting.

## Quirks

- Codex CLI emits both `last_token_usage` (per turn) and `total_token_usage` (cumulative). The parser handles three modes:
  1. `last_token_usage` present: use it directly.
  2. Only cumulative: compute deltas against the prior turn.
  3. Neither: estimate from message text length (`CHARS_PER_TOKEN = 4`).
- `prevCumulativeTotal` is initialized to `null`, not `0`. A session whose first event reports `total = 0` would otherwise be dropped as a "duplicate" of the initial state.
- `prev*` token counters are advanced on **every** event, including ones that used `last_token_usage`. Earlier code only updated them on the fallback branch, which double-counted any session that mixed modes.
- OpenAI counts cached tokens **inside** `input_tokens`. The parser subtracts them so the rest of the codebase can assume Anthropic semantics (cached are separate).

## Live quota (ChatGPT subscription)

Separate from the log parser above: the desktop app and the macOS menubar read
live quota from `GET https://chatgpt.com/backend-api/wham/usage` using the Codex
OAuth token. Two independent implementations of the same decoder, which must be
kept in sync:

- `app/electron/quota/codex.ts`: `decodeCodexUsage()` is the pure, exported decoder.
- `mac/Sources/CodeBurnMenubar/Data/CodexSubscriptionService.swift`: `decodeUsage()`.

### Seat-based plans (Plus, Pro, Team)

`rate_limit.primary_window` / `secondary_window` carry `used_percent`,
`reset_at` and `limit_window_seconds`. The window *label* is inferred from the
duration (5-hour, Weekly, …), never from the plan, because window size is dynamic per
account. `additional_rate_limits[]` holds per-model limits (Codex Spark, etc.)
and is only surfaced when utilization is non-zero.

### Credit-metered plans (Business, Edu, Enterprise on flexible pricing)

These workspaces have **no rate-limit windows**: `rate_limit` comes back
`null`. Usage scales with credits, and an admin sets a monthly per-user credit
allowance. That allowance is the account's only limit and lives in
`spend_control`:

```jsonc
"spend_control": {
  "reached": false,
  "individual_limit": {
    "source": "workspace_spend_controls",
    "limit": "10000",              // string
    "used": "3028.9909675121307",  // string
    "used_percent": 30,            // number
    "remaining_percent": 70,
    "reset_after_seconds": 441896, // time *remaining*, not window length
    "reset_at": 1785542400
  }
}
```

Notes that have bitten us:

- **Number encodings are mixed within the same object**: `limit` and `used`
  arrive as strings while `used_percent` arrives as a number. Every numeric
  field is decoded flexibly (number | string) on both sides.
- **`reset_after_seconds` is not the window length.** Pace projection needs the
  whole-window duration, so it is derived as the calendar month preceding
  `reset_at`, resolved in **UTC**: `reset_at` is a UTC boundary, and a local
  calendar would make the month length depend on the viewer's timezone (a
  2026-03-01Z reset spans 28 days in UTC but 31 in Toronto).
- Two other positions for this object have been observed in other clients
  (top-level `individual_limit`, and nested under `rate_limit`), in both
  snake_case and camelCase. All are accepted; `spend_control` wins.
- `credits.has_credits` means the account settles in **credits, not dollars**, so
  `credits.balance` must not be rendered with a currency symbol in that case.
  `credits.unlimited` means credit-metered but deliberately uncapped.
- **`has_credits` is not "is credit-metered".** The live Enterprise workspace
  above is credit-metered (it has a `spend_control` allowance) yet reports
  `has_credits: false` with a `null` balance, so the flag tracks whether the
  account holds a *credit balance*, which is orthogonal to the allowance. Do not
  derive one from the other. The `has_credits: true` rendering path has not been
  observed against a real account; if a seat-based account ever reports it
  alongside a dollar balance, the footer would drop the `$` and round to whole
  units.

### `plan_type` cannot distinguish Business from Enterprise

A live ChatGPT **Enterprise** workspace reports `plan_type: "business"` on this
endpoint, and the `id_token`'s `https://api.openai.com/auth → chatgpt_plan_type`
claim says `"business"` too, even though ChatGPT's own workspace switcher
displays "Enterprise". Neither source carries the distinction, so the label
CodeBurn shows is faithfully what OpenAI returns. Do not try to infer a tier
from the presence of a spend control.

The switcher renders from the accounts endpoints, and **those are not reachable
with a Codex token**, verified against a live Enterprise workspace:

| Endpoint | Result |
| --- | --- |
| `/backend-api/accounts/check/v4-2023-04-27` | 403 |
| `/backend-api/accounts/check` | 403 |
| `/backend-api/me` | 403 |
| `/backend-api/settings/account_user_setting` | 403 |

Not an expiry or a missing-header problem: the same token returns 200 on
`/wham/usage` (and on `/backend-api/gizmo_creator_profile`) in the same run. The
Codex OAuth access token carries scopes `openid profile email offline_access
api.connectors.read api.connectors.invoke` with audience
`https://api.openai.com/v1`, with no ChatGPT web-app account scope, so the accounts
surfaces reject it by design. Adding a `ChatGPT-Account-Id` header does not
change this. **Business is therefore the correct label to display**; closing
this gap would need a different credential, not a different endpoint.

Composite tiers (`enterprise_cbp_usage_based`, `self_serve_business_usage_based`)
*are* normalized down to their base tier before lookup.

### Reset credits

`rate_limit_reset_credits` is carried inline on the usage payload
(`available_count`, and sometimes `applicable_available_count` — how many can be
applied right now). The dedicated `GET /wham/rate-limit-reset-credits` endpoint
is only called when the inline block is absent or non-zero. It is the sole
source of the per-credit list — `id`, `reset_type`, `status`, `granted_at`,
`expires_at` — so the "next expires" caption and the "latest grant" caption are
both omitted on the inline path.

**Banked resets.** OpenAI sometimes grants an account an extra reset out of
band. A credit whose identity (`id`, else its raw `granted_at`) has not been
seen before is a new grant, and the menubar notifies once per credit. The seen
set lives in `codex-banked-resets.json` in the CodeBurn cache directory, written
the same way `subscription-snapshots.json` is. Rules that matter: the first
observation is a baseline, a disappearing credit was spent and is not an event,
and an absent or malformed credits payload is *no opinion* — never an empty
account — so a failed fetch cannot cause a re-announcement on reconnect. The CLI
reads the same inventory from the inline block only; it never calls the
companion endpoint.

Nothing in the payload distinguishes a granted-but-not-yet-usable credit from a
usable one: there is no `available_at`, no pending status, and `granted_at` has
only ever been observed in the past. The earliest warning CodeBurn can give from
this source is therefore "it just landed", not "it lands at 5pm".

## When fixing a bug here

1. Reproduce against a real `rollout-*.jsonl` if you can. Drop a redacted copy under `tests/fixtures/codex/` and reference it from `tests/providers/codex.test.ts`.
2. If the bug is "zero tokens reported", first check whether the file is being skipped by `isValidCodexSession`.
3. If the bug is "tokens counted twice", look at `prevCumulativeTotal` and the prev-counter advancement.
4. If you change the dedup key shape, run `tests/providers/codex.test.ts` and `tests/parser-filter.test.ts` together; cross-provider dedup happens via the global `seenKeys` Set.
