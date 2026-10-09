# Antigravity 2.16 quota responses

Captured on macOS from a signed-in Antigravity 2.16.0 local language server
on 2026-10-07 for issue #1613. `summary.json` retains the response envelope
and four quota buckets returned by `RetrieveUserQuotaSummary`. `status.json`
retains two model rows from `GetUserStatus`.

Only public model/bucket labels, remaining fractions, and reset times are
retained. Account data, credentials, process arguments, and unrelated fields
are omitted. Both the CLI and Electron quota readers run against these fixtures.
