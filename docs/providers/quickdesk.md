# Quick Desktop

Amazon Quick Desktop local usage and session history.

- **Source:** `src/providers/quickdesk.ts`
- **Loading:** eager
- **Test:** `tests/providers/quickdesk.test.ts`

## Where it reads from

The provider reads `~/.quickwork` by default and honors `QUICKWORK_HOME`.

When `profiles.json` contains `entries[{ id, data_path }]`, every `data_path` is scanned and the entry `id` is used as the project. Relative paths resolve from the store root; absolute paths are used as written. `last_active` is not used for filtering. If the store root also contains `sessions/sessions.db`, that migrated legacy history is scanned as the `default` profile alongside the manifest entries. If the profile manifest is missing, unreadable, malformed, or has no usable entries, the provider scans the store root as the legacy `default` profile.

For each profile base it reads:

- `metrics/metrics-YYYY-MM-DD.jsonl`
- `sessions/sessions.db`

`probeRoots()` reports the same resolved profile bases for `codeburn doctor`.

## Storage format

Metrics files contain one AWS Embedded Metric Format JSON object per line. A usage row must have `Model`, `InputTokens`, and `OutputTokens`. `_aws.Timestamp` is milliseconds since the Unix epoch; when it is absent, the date in the metrics filename is used at midnight UTC. A numeric `CostUSD` is preserved as measured cost. Rows without `CostUSD` are priced through codeburn's existing model pricing and marked estimated. Tool-only rows in the file are linked to usage by `session_id`; `thread_id` may be present but is not required for the link. Malformed lines are skipped independently.

The SQLite database is opened read-only through `src/sqlite.ts`. The provider introspects `sqlite_master` and table columns before querying `sessions` or `session_messages`. It uses non-deleted sessions for the first user message and tools. A non-deleted session absent from every metrics file gets one estimated `quickdesk-auto` call: user and non-assistant content is input, assistant content is output, and characters are converted at four characters per token. Missing tables or columns disable only the affected enrichment or fallback; metrics remain usable.

The on-disk schema is reverse-engineered. AWS officially documents the `.quickwork` root, but does not publish a contract for `profiles.json`, metrics JSONL, or `sessions.db`.

## Caching

Quick Desktop is an eager provider using the shared session cache. Each metrics file and profile database is a separate cache source. The `QUICKWORK_HOME` value and the Quick Desktop parser version participate in the provider cache fingerprint. Sources are durable because Quick Desktop may prune its managed store; cached records are retained when a previously discovered source disappears.

## Deduplication

Metrics calls with a session use `quickdesk:<session_id>:<timestamp>:<model>:<input>:<output>`. Session-less calls use `quickdesk:<profile>:<file>:<timestamp>:<model>:<input>:<output>`. Estimated database-only sessions use `quickdesk-est:<session_id>`. All keys are stable across runs.

## Quirks

- Quick Desktop can delegate to Kiro or Claude Code. If Quick Desktop metrics meter the same delegated calls that those native stores persist, enabling all providers may double-count that traffic. No sanitized real store has yet resolved this caveat.
- The metrics directory location is reverse-engineered as `<profile_base>/metrics`; it is not an official AWS schema guarantee.
- Deleted sessions are excluded when `sessions.deleted_at` is available. On an older schema without that column, metrics are retained because deletion state cannot be determined.
- `sessions.db` uses WAL journaling, so the main file fingerprint can lag until checkpoint. A session estimated in one run can briefly coexist with its first real metrics rows in the next; this transient estimated-plus-real overlap self-heals when the database file changes.

## When fixing a bug here

1. Test both a multi-profile manifest and the legacy root layout.
2. Keep metrics parsing independent from optional SQLite enrichment.
3. Add malformed-line and missing-table coverage for every newly observed schema variant.
