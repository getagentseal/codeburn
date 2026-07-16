# Sync — Developer Documentation

Architecture, protocol, server contract, and testing for `codeburn sync`.

## Architecture

```
Developer machine                          Remote backend
──────────────────                         ──────────────
~/.config/codeburn/sync.json  (config)
~/.config/codeburn/.sync-token (credential)
~/.cache/codeburn/sync-ledger.json (sent-ledger)

codeburn sync push
  │
  ├─ Read config → baseUrl, clientId, issuer, tracesPath
  ├─ Read refresh token from OS store
  ├─ POST {issuer}/oauth2/token (refresh_token grant) → access_token
  ├─ Collect ParsedProviderCall[] for window
  ├─ Filter against sent-ledger (only unsent calls)
  ├─ Build OTLP/HTTP JSON payload
  ├─ POST {baseUrl}{tracesPath} with Bearer token
  ├─ On success → append deduplicationKeys to ledger
  └─ Update lastSync in config
```

## Discovery Protocol

### Server discovery document

```
GET {baseUrl}/.well-known/codeburn-export.json
```

```json
{
  "version": 1,
  "issuer": "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_XXXX",
  "client_id": "70e6sgst2ju6ff9dnrmv4l1tcb",
  "scopes": ["openid", "email"],
  "traces_path": "/v1/traces",
  "max_batch_size": 1000
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `version` | No | `1` | Client rejects `version > 1` |
| `issuer` | Yes | — | OIDC issuer URL. Client fetches `{issuer}/.well-known/openid-configuration` |
| `client_id` | Yes | — | OAuth client ID for this deployment |
| `scopes` | No | `["openid"]` | Scopes to request. `offline_access` added dynamically if IdP supports it |
| `traces_path` | No | `/v1/traces` | Path for OTLP POST |
| `max_batch_size` | No | `1000` | Max spans per HTTP request |

### Why not proxy `.well-known/openid-configuration`?

OIDC requires the `issuer` claim inside the discovery doc to match the URL it was fetched from. Serving Cognito's doc from a different domain violates this constraint. The `codeburn-export.json` doc decouples the metrics endpoint from the identity provider.

## OIDC Authentication

### Flow: Authorization Code + PKCE

1. Client generates `code_verifier` (32 random bytes, base64url) and `code_challenge` (SHA-256 of verifier, base64url)
2. Client starts callback server on `127.0.0.1:19876` (fallback: 19877, 19878)
3. Browser opens `{authorization_endpoint}?response_type=code&client_id=...&redirect_uri=http://127.0.0.1:{port}/callback&code_challenge=...&code_challenge_method=S256&state=...&scope=...`
4. User logs in at IdP → IdP redirects to `http://127.0.0.1:{port}/callback?code=...&state=...`
5. Callback server validates `state`, extracts `code`
6. Client POSTs to `{token_endpoint}` with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`
7. IdP returns `access_token` + `refresh_token`

### Fixed ports

Cognito (and Okta) do exact string comparison on callback URLs. Ephemeral ports fail. We register three fixed ports: `19876`, `19877`, `19878`. The client tries in order, falling back if a port is in use.

RFC 8252 recommends `127.0.0.1` (IP literal) over `localhost` to avoid IPv6 `::1` resolution.

### Token refresh

On every `sync push`:
1. Read refresh token from OS store
2. POST `{token_endpoint}` with `grant_type=refresh_token`
3. Store whatever refresh token the server returns (handles rotation transparently)
4. On `invalid_grant` → stop, prompt user to re-run `sync setup`

### Scope resolution

- Request scopes from `codeburn-export.json`
- Add `offline_access` only if `scopes_supported` in OIDC discovery includes it
- Cognito rejects `offline_access` as `invalid_scope` — it issues refresh tokens without it

## Credential Storage

| Platform | Method | Implementation |
|---|---|---|
| macOS | Keychain | `security add-generic-password` / `find-generic-password` |
| Linux | libsecret | `secret-tool store` / `secret-tool lookup` |
| Windows | DPAPI | PowerShell `ConvertTo-SecureString` / `ConvertFrom-SecureString` |
| Fallback | File | `~/.config/codeburn/.sync-token` with `0600` permissions |

No native modules (`keytar` is archived). Shell out to OS CLIs. Fallback reported honestly in `sync status`.

## OTLP Encoding

Strict protobuf-JSON mapping of `ExportTraceServiceRequest`. lowerCamelCase fields, hex-encoded IDs, integer enums.

### Span identity (deterministic)

```
span_id   = first 8 bytes of SHA-256(deduplicationKey) → hex (16 chars)
trace_id  = first 16 bytes of SHA-256(sessionId)       → hex (32 chars)
```

Re-sends are byte-identical. Server-side dedup is defense-in-depth.

### Resource attributes

```json
{
  "resource": {
    "attributes": [
      { "key": "codeburn.device_id", "value": { "stringValue": "<SHA-256(hostname+username)[:16]>" } }
    ]
  }
}
```

### Span attributes

```json
{
  "attributes": [
    { "key": "ai.provider", "value": { "stringValue": "kiro" } },
    { "key": "ai.model", "value": { "stringValue": "claude-sonnet-4-6" } },
    { "key": "ai.input_tokens", "value": { "intValue": "12500" } },
    { "key": "ai.output_tokens", "value": { "intValue": "3200" } },
    { "key": "ai.cost_usd", "value": { "doubleValue": 0.085 } },
    { "key": "ai.project", "value": { "stringValue": "my-app" } },
    { "key": "ai.tools", "value": { "arrayValue": { "values": [{ "stringValue": "Edit" }] } } },
    { "key": "ai.speed", "value": { "stringValue": "standard" } },
    { "key": "ai.cost_estimated", "value": { "boolValue": true } }
  ]
}
```

## Sent-Ledger

Client-side deduplication source of truth at `~/.cache/codeburn/sync-ledger.json`.

Format: JSON array of `{ key: string, ts: string }` objects.

**Push logic**: collect all calls in window → subtract ledger entries → send remainder → append to ledger on success.

**Pruning**: entries older than 6 months removed on every push.

**Why not a watermark?** Timestamp watermarks silently skip late-arriving calls (long sessions, providers that update rows). The ledger is exact.

### Partial success

OTLP returns `partial_success.rejected_spans` in the response body. Because OTLP does not identify *which* spans were rejected, the client ledgers nothing for a partially-rejected batch — the entire batch retries on the next push. This is safe: span IDs are deterministic (derived from the deduplication key), so servers that store by span ID treat re-sent spans as idempotent upserts.

### Rate limiting (429)

A push runs to completion — there is no routine per-push cap (only a 50,000-call safety valve). Server rate limits are the intended brake:

- On HTTP 429 the client honors `Retry-After` (delta-seconds or HTTP-date), capped at 120 seconds per wait, defaulting to 5 seconds when the header is absent
- The same batch is retried up to 3 consecutive times; if the server is still rate-limiting after that, the push stops and the remaining (unledgered) calls are sent on the next push
- On 401 or 5xx the push stops immediately with the same resume-on-next-push behavior

### Server contract

The backend must implement:

1. `GET {baseUrl}/.well-known/codeburn-export.json` — returns the discovery doc (public, no auth)
2. `POST {baseUrl}{traces_path}` — accepts OTLP/HTTP JSON with Bearer token
   - Validate JWT (issued by the configured IdP)
   - Derive developer identity from token's `sub` claim
   - Accept `startTimeUnixNano` up to 6 months in the past
   - Return standard OTLP response body

No PII is included in the payload. The server derives identity solely from the authenticated token.

## Testing

### Unit tests (`tests/sync.test.ts`)

26 tests covering pure functions: discovery parsing, PKCE generation, auth URL construction, scope resolution, callback server, config read/write. No network, no browser.

### Mock IdP e2e (`tests/sync-e2e.test.ts`)

6 tests with a localhost mock IdP server. Exercises the full auth round-trip, token refresh, rotation, revocation — fully offline, runs in CI.

### Headless browser e2e (`tests/sync-headless-e2e.test.ts`)

1 test with Playwright headless Chromium against real Cognito. Proves the actual browser PKCE flow works including Cognito Hosted UI form submission and localhost redirect.

**Developer-only** — requires:
- Deployed test backend (CDK stack at `../codeburn-sync-backend/`)
- Cognito user with confirmed password
- Environment variables: `CODEBURN_SYNC_URL`, `CODEBURN_SYNC_EMAIL`, `CODEBURN_SYNC_PASSWORD`
- Playwright Chromium installed (`PLAYWRIGHT_BROWSERS_PATH`)

Skipped by default when env vars are not set. Never runs in CI.

### Test CDK stack (`codeburn-sync-backend/`)

Minimal AWS backend for the headless e2e test:
- Cognito User Pool (PKCE, fixed callback ports)
- HTTP API with JWT authorizer
- Discovery Lambda (serves `codeburn-export.json`)
- Ingest Lambda (logs OTLP spans to CloudWatch)

Deploy: `npx cdk deploy --profile andklee-dev`
Cost: ~$0/mo idle (pay-per-request)

This is a **test fixture**, not a production reference. Any OIDC provider + OTLP-accepting endpoint satisfies the server contract.
