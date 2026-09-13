# Session groups and the By-agent lens (CodeBurn Desktop)

CodeBurn Desktop can show an orchestration root together with the subagents it
spawned, the cost of the whole group, and each member's contribution — without
running any CLI command by hand. The same population also gains a **By agent**
lens in Models, mirroring the CLI's `models --by-agent` breakdown.

## Sessions → Group by work units

The Sessions section has three list views:

- **Group by provider** (default) — the existing list under provider headers.
- **Flat** — the same list without headers.
- **Group by work units** — sessions grouped by orchestration lineage.

Only lineage the provider durably recorded is honored (Claude subagent
sidechains; Kimi Code parent links). Nothing is inferred from timestamps,
shared projects, or directory names.

A group row shows:

- the root session's title (or project when untitled) and project,
- the number of descendant agents,
- the models the group ran,
- whole-group totals for the selected period, with the root's own cost
  separated from the descendants' (`root $2.00 + agents $8.00` above).

Expanding a group lists its members — root first, then descendants — with each
member's agent type when the provider recorded one (`Explore`,
`general-purpose`, …), its model, and its own contribution. The root carries no
invented agent type; it is labeled `root session`. A child of a child folds
under the same root and is counted once; no intermediate parent is invented.

The summary line counts **sessions and groups separately** (`4 sessions · 1
group · $17.00`), and its total sums only top-level rows — expanding a group
never changes it, because member detail is never re-summed into the total.

### What grouping never does

- Sessions with no recorded lineage stay standalone — missing links are not
  missing spend.
- A child whose parent is outside the selected period stays visible as a
  standalone row (fail closed, per the resolver's rules).
- Ambiguous duplicate identities never fold; they render standalone.
- Search shows the whole group when any member matches, flagging only the
  matching members (`· search match`). Searching also matches a member's agent
  type. Changing the period or provider closes any open group or member
  detail, so nothing from an older population stays on screen.

## Models → By agent

The Models section gains a **By agent** lens next to By model / By task. It is
fed by the CLI's existing `models --by-agent` command: one row per
(provider, model, agent) with the recorded subagent type, bucketed under its
model group. Ordinary sessions and providers that record no agent type fall
under the CLI's `(main)` bucket — no agent is invented. Totals reconcile with
the CLI report on the same selection.

## CLI counterparts

Everything the UI shows is already available for scripts:

```bash
codeburn sessions --by-work-unit                  # grouped table
codeburn sessions --by-work-unit --format json    # { sessions, workUnits } envelope
codeburn models --by-agent --format json          # per-(provider, model, agent) rows
```

The JSON envelope's `sessions` rows are exactly the default `sessions --format
json` rows (plus `agentType`), and each `workUnits` entry carries
provider-scoped identity (`rootProvider`, `members[{sessionId, provider,
role}]`) so two sessions sharing an id across different providers stay
separable.

## Dev isolation (parallel checkouts)

Two environment variables keep parallel checkouts of this repo from fighting
each other; both default to off and change nothing when unset:

- `CODEBURN_DEV_PORT` — the Vite port for `npm --prefix app run dev`
  (default 5173). The Electron dev launcher (`app/scripts/dev.mjs`) wires
  `wait-on` and `VITE_DEV_SERVER_URL` to the same port.
- `CODEBURN_USER_DATA_DIR` — redirects the Electron `userData` profile
  (including `serve.pid`, telemetry, and tray settings) for the dev app.
- `CODEBURN_DEMO_BRIDGE=1` — dev-server-only harness: loads the repo's
  browser-demo shim (`app/demo-bridge.mjs` on 127.0.0.1:4900) so the renderer
  runs in a plain browser tab against the real CLI. Never active in
  production builds.
