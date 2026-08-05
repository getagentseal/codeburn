# codeburn sync

Push your AI usage telemetry to a shared backend so teams can track adoption, budgets, and ROI across developers.

Everything stays local-first: codeburn never sends data without your explicit action, and prompts/code are never included.

## Quick Start

```bash
# One-time setup (opens browser for login)
codeburn sync setup https://metrics.your-team.com

# Push recent usage
codeburn sync push

# Check status
codeburn sync status
```

## Commands

### `codeburn sync setup <url>`

Configures sync with a remote endpoint. Opens your browser for a one-time OIDC login.

```bash
codeburn sync setup https://metrics.your-team.com
```

What happens:
1. Fetches server configuration from `<url>/.well-known/codeburn-export.json`
2. Opens your browser to the identity provider's login page
3. After login, stores a refresh token securely in your OS keychain
4. Saves the endpoint configuration (no secrets) to `~/.config/codeburn/sync.json`

You only need to do this once. The token refreshes silently on every push.

### `codeburn sync push`

Sends unsent AI usage data to the configured endpoint.

```bash
# Push unsent calls from the last 7 days (default)
codeburn sync push

# Push a larger window
codeburn sync push --since 30d

# Preview what would be sent
codeburn sync push --dry-run

# Also push git attribution (opt-in — see "Git attribution" below)
codeburn sync push --attribution
```

### `codeburn sync status`

Shows the current sync configuration and authentication state.

```
Endpoint: https://metrics.your-team.com
Traces path: /v1/traces
Issuer: https://auth.your-team.com
Auth: configured
Token storage: keychain
Last sync: 2h ago
```

### `codeburn sync logout`

Removes stored credentials and revokes the token at the identity provider.

```bash
codeburn sync logout
```

### `codeburn sync reset --confirm`

Clears the sent-ledger, causing the next push to re-send all data in the window. Use after a backend migration or if you suspect missing data.

```bash
codeburn sync reset --confirm
```

## What Gets Sent

Each AI interaction becomes one OTLP span with these attributes:

| Field | Example | Description |
|---|---|---|
| `ai.provider` | `kiro`, `cursor`, `claude` | Which AI tool |
| `ai.model` | `claude-sonnet-4-6` | Model used |
| `ai.input_tokens` | `12500` | Prompt tokens |
| `ai.output_tokens` | `3200` | Response tokens |
| `ai.cost_usd` | `0.085` | Estimated cost |
| `ai.project` | `my-app` | Project name |
| `ai.tools` | `["Edit", "Bash"]` | Tools invoked |

A keyed `device_id` (HMAC of hostname and username under a per-install key that never leaves the machine) distinguishes your machines without revealing hostnames.

### Git attribution (opt-in: `--attribution`)

`codeburn sync push --attribution` additionally sends the session→commit correlation that `codeburn yield` computes locally, so the backend can join AI usage to git activity without git hooks. Two extra span types are emitted:

**`codeburn.session.attribution`** — one per session with joinable evidence:

| Field | Example | Description |
|---|---|---|
| `ai.session_id` | `abc123…` | Session (shares the usage spans' traceId) |
| `ai.project` | `my-app` | Project name |
| `git.repo` | `github.com/acme/widget` | Normalized `origin` remote (credentials and ports stripped) |
| `git.pr_links` | `["…/pull/12"]` | PR URLs captured for the session |
| `git.commit_count` | `2` | Number of attributed commits |

**`codeburn.commit`** — one per commit attributed to a session:

| Field | Example | Description |
|---|---|---|
| `git.sha` | `4f2a…` | Commit SHA |
| `git.in_main` | `true` | Whether the commit landed in the main branch |
| `git.was_reverted` | `false` | Whether a later commit reverted it |

Attribution is **inferred** (timestamp-window correlation, the same heuristic as `codeburn yield`); the resource attribute `codeburn.attribution_methodology: timestamp-window` marks it as such. State transitions (a commit merging to main, or being reverted) are re-sent automatically on later pushes — receivers should upsert commits by `(git.repo, git.sha)` and session spans by `ai.session_id` (latest state wins). When a commit migrates to a later-parsed session with a tighter window, the losing session re-emits with `git.commit_count: 0` (a retraction), so summing `git.commit_count` across upserted session rows never double-counts. Retractions fire only when the commit was won by another session — commits that merely age out of the `--since` window are not retracted, so a previously-synced count stays correct. Session spans also re-emit when an ongoing session's window grows, keeping the span end time current.

With `--attribution`, normalized repo remote URLs, commit SHAs, commit timestamps (span start times), PR URLs, and the merged/reverted booleans leave your machine — plus the same pseudonymous `codeburn.device_id` resource attribute the usage spans carry. PR links are rebuilt client-side from scheme + host + path only (userinfo, query strings, and fragments are dropped; https, `/org/repo/pull/N` path, bounded length, max 20 per session), and the repo identity itself passes a strict hostname/path allow-list before sending — malformed or transport-helper remotes (`ext::…`, `codecommit::…`) are rejected outright rather than parsed. Precisely what is and is not sent:

- **Commits**: only from repos with a network `origin` remote, and only for sessions whose own project path resolved to that repo. Local-only repos, `file://` remotes, and Windows filesystem paths are never emitted as repo identities. A session whose project path no longer resolves never inherits the repo of the directory you happen to push from.
- **PR links**: sent whenever a session captured them, even when the session's repo could not be identified — the PR URL itself names the repo, so this adds no information beyond the link the session already recorded.
- Without the flag, none of this is sent.

### What is NOT sent

- **Prompts** — your actual messages to AI are never included
- **Code** — file contents, diffs, and paths stay local
- **Bash commands** — may contain secrets, never sent
- **Your name/email** — identity is derived server-side from your login token

There is no flag to override this. Privacy is structural, not configurable. The only additive opt-in is `--attribution` (repo remotes, commit SHAs, and PR URLs — never code or prompts), described above.

## Authentication

Sync uses standard OIDC (the same protocol as "Sign in with Google"). Your team's admin sets up the identity provider — you just click through the browser login once.

- **Token storage**: macOS Keychain, Windows Credential Manager, or Linux libsecret. Falls back to a `0600` file if no keychain is available.
- **Token lifetime**: typically 30–90 days (set by your admin). You'll be prompted to re-login when it expires.
- **Re-login**: run `codeburn sync setup <url>` again.

## FAQ

**Q: Does sync run automatically?**
A: No. You run `codeburn sync push` when you want. A future version may offer opportunistic push (after each `codeburn report`), but it's always explicit.

**Q: What if I push the same data twice?**
A: Safe. A local sent-ledger tracks what's been sent. Re-pushing the same window doesn't create duplicates.

**Q: What if I'm offline for a week?**
A: Next push catches up. The default window is 7 days; use `--since 30d` or `--since all` (up to 6 months) for longer gaps. A push runs to completion regardless of size — server rate limits (429) are waited out automatically.

**Q: Can my admin see my prompts?**
A: No. Prompts are never included in the payload. The server only sees token counts, costs, model names, and project names.

**Q: How do I stop syncing?**
A: `codeburn sync logout` removes everything. Or just stop running `push`.
