# CodeBurn MCP Server — Design Spec

- **Date:** 2026-06-02
- **Status:** Approved design (pre-implementation)
- **Author:** brainstormed + validator/devil's-advocate hardened

## 1. Context & Goal

CodeBurn already aggregates rich AI-coding usage/cost data (by task, model, project, provider; retry tax; routing waste; optimize findings; 365-day history). This spec adds an **MCP server** that exposes that data to AI agents (Claude Code, Cursor, Claude Desktop) so an agent can answer "where did my tokens go?" and "how do I spend less?" mid-conversation.

**Why (and why not):** This is a **product / differentiation** play, not a downloads play. We measured that MCP is a niche *download* lever (`@ccusage/mcp` ≈ 1.1% of ccusage's downloads; competitor tokscale ships no MCP), and the real download lever is npx-first CLI positioning — tracked separately. The MCP's value is agent-facing utility on data competitors don't expose (retry tax, routing waste, one-shot rate, task attribution).

## 2. Decisions (from brainstorming)

1. **Use case:** unified — serves both live self-optimization and historical analysis from one tool set.
2. **Output contract:** every tool returns a ready-to-display **markdown table** *and* the same data as **structured JSON**.
3. **Architecture:** Approach A — a `codeburn mcp` subcommand on the existing CLI (no second package), reusing the existing aggregation; run as a **long-lived in-process stdio server**.
4. **Tool surface:** **2 tools** — `get_usage` and `get_savings`. (`compare_periods` cut — no reusable backend, overlap-incoherent.)
5. **Privacy:** project/session names **hashed by default** (`project-<6hex>`); real names only when `include_project_names: true`. Absolute paths never exposed.

## 3. Architecture

### Process model
- `codeburn mcp` starts a **resident, in-process** MCP server over **stdio** (`StdioServerTransport`). Not exec-per-call — a resident process is required so the existing in-process session cache (180s TTL, `src/parser.ts`) amortizes across tool calls. Measured cost otherwise: `--period all` is ~17.6s **even warm** when the process exits between calls.
- **First line of the `mcp` action:** `console.log = console.error`. The aggregation path is stdout-clean today (writes go to stderr), but the global `preAction` hook and `runOptimize` contain stdout `console.log`s; reassigning immunizes the JSON-RPC stream against any present or future stdout write. (Verified: `scanAndDetect`, `parseAllSessions`, providers, caches, `buildMenubarPayload` do not write to stdout.)
- Pre-warm `today` usage on boot so the first interactive call is fast.

### Modules
- **`src/usage-aggregator.ts`** *(new)* — extracted from the inline logic in the `status` handler (`src/main.ts` ~476–760):
  - `buildUsage(period, opts): Promise<MenubarPayload>` — **cheap path**, no optimize pass.
  - `buildSavings(period, opts): Promise<MenubarPayload>` — adds `scanAndDetect` (optimize findings + retry tax + routing waste).
  - `opts: { provider?: string; project?: string[]; exclude?: string[]; range?: ResolvedRange }`. The `provider` and project/range filters are **required** for parity — the `status` body forks on `isAllProviders` and resolves a range from `day/days/from/to` before `period`. `status --format menubar-json` is refactored to call these (one shared path).
- **`src/mcp/server.ts`** *(new)* — builds `McpServer`, registers the 2 tools, connects `StdioServerTransport`, owns the in-flight coalescing map and the empty-state messages.
- **`src/mcp/tables.ts`** *(new)* — compact markdown renderers per slice, reusing `format.ts` and `models-report.ts` where they already render tables.
- **`src/mcp/redact.ts`** *(new)* — stable pseudonym hashing for project/session names; applied unless the caller passes `include_project_names: true`.
- **`src/main.ts`** — add `.command('mcp')` that dynamic-`import()`s `./mcp/server.js` and starts it.

### Dependencies & build
- Add to **`dependencies`**: `@modelcontextprotocol/sdk@^1.29.0` (v1 line; import paths `@modelcontextprotocol/sdk/server/mcp.js` and `/server/stdio.js`) and `zod@^3.25` (NOT transitive — it's a peer dep of the SDK and absent from the lockfile today).
- Add to **`tsup.config.ts`**: `external: ['@modelcontextprotocol/sdk', 'zod']`. The current config bundles all deps (`splitting: false`, no `external`), so without this a dynamic import would inline the SDK (~MBs) into `dist/main.js`. Externalizing keeps `dist` small and makes the dynamic import a real lazy load from `node_modules`. (`files: ["dist"]` means externalized deps must be runtime `dependencies`.)
- Pin the SDK major: a separately-named v2 package exists with different import paths; `^1.29.0` keeps the v1 paths valid.

## 4. Tool Surface

Period enum (LLM-clear names, mapped internally): `today→today`, `last_7_days→week`, `last_30_days→30days`, `month_to_date→month`, `last_6_months→all`. Documented: `last_6_months` is the maximum window (codeburn's "all" = ~6 months); history is summarized, not dumped.

Both tools carry annotations `{ readOnlyHint: true, openWorldHint: false, idempotentHint: true, title }`, a zod `inputSchema` and `outputSchema`, and return `{ content: [{ type:'text', text: <markdown table> }], structuredContent: <object matching outputSchema> }`.

### 4.1 `get_usage`
- **title:** "CodeBurn — usage & cost"
- **description (agent-facing):** "Show AI coding token spend and usage for a period. Omit `by` for a headline summary; set `by` to break it down by project, model, task, or provider. Fast (does not run the deeper savings analysis). Data is local to this machine and current as of the last scan."
- **inputSchema:**
  - `period?: enum` (default `today`)
  - `by?: "project" | "model" | "task" | "provider"`
  - `limit?: number` (default 20, max 100) — row cap for breakdowns
  - `include_project_names?: boolean` (default `false`)
- **Behavior:** no `by` → headline (cost, calls, sessions, input/output tokens, cache-hit %, one-shot rate) + top-N models/projects/tasks. With `by` → one ranked table for that dimension (`project→topProjects`, `model→topModels`, `task→topActivities`, `provider→providers` cost map). Uses `buildUsage` (cheap path).
- **outputSchema:** the relevant subset of `MenubarPayload.current` (typed).

### 4.2 `get_savings`
- **title:** "CodeBurn — savings opportunities"
- **description (agent-facing):** "Find ways to reduce AI coding cost for a period: optimization findings, retry tax (money spent re-doing work), and routing waste (what you'd have saved on a cheaper model). Runs a deeper analysis, so it is slower than get_usage."
- **inputSchema:** `period?: enum` (default `last_7_days` — never default to the slow `last_6_months`), `include_project_names?: boolean` (default `false`).
- **Behavior:** runs `buildSavings`; returns optimize findings (title, impact, $ saved), retry tax (total + by model), routing waste (total savings, baseline model, by model).
- **outputSchema:** `{ optimize, retryTax, routingWaste }` (typed).

### 4.3 Server `instructions`
> "CodeBurn exposes local AI-coding spend data. Use `get_usage` for spend/usage and breakdowns (fast); use `get_savings` to find cost reductions (slower). Project names are pseudonymized unless you pass `include_project_names: true`. All data is read locally from this machine; `last_6_months` is the widest window. Numbers reflect the most recent scan and may lag the current in-flight session by a short interval."

## 5. Data Flow

```
agent tool call
  → zod inputSchema validation        (invalid params → protocol error, auto)
  → in-flight coalesce on {kind, period, opts-hash}  (parallel callers share one scan)
  → buildUsage / buildSavings(period, {provider:'all', ...})
        → parseAllSessions with PER-PROVIDER allSettled isolation → degraded[]
        → existing 180s in-process session cache amortizes
  → redact project/session names unless include_project_names
  → render markdown table + build structuredContent (validated vs outputSchema)
  → return { content:[{type:'text',text}], structuredContent }   (isError:true on failure)
```

## 6. Privacy / Redaction
- Name-bearing fields — `topProjects[].name`, `topSessions[].project`, `topProjects[].sessionDetails` — are replaced with stable pseudonyms `project-<6hex(sha256(name))>` unless `include_project_names: true`.
- Absolute paths are never emitted (they aren't in the payload today; the MCP must not enrich with them).
- Rationale: an MCP is an egress surface to possibly-remote/cloud agents; codeburn's brand is "data never leaves your machine." Hashing keeps breakdowns coherent (stable pseudonyms) without leaking identity; local users who want real names opt in per call.

## 7. Performance
- **Two paths:** `get_usage` uses the cheap aggregation (`--no-optimize` seam already exists; ~3s `today`, ~5s `all`). `get_savings` runs the optimize pass (~+13s) — isolated to the one tool that needs it. Without this split, every tool paid the 13s tax.
- **Resident process** + existing 180s session cache → warm calls are cheap.
- **In-flight coalescing:** concurrent calls for the same `{kind, period, opts}` await a single scan (agents fire tools in parallel).
- **Pre-warm** `today` usage on boot.
- **Token discipline:** breakdowns capped at `limit` (default 20); history is summarized (totals + top-N), never the full 365-day array; tables are compact.

## 8. Error Handling
- Invalid params → zod → MCP protocol error (auto).
- No data for period (fresh install) → `isError: false` with a friendly "no usage recorded for <period> yet — run some coding sessions" message (not a zero-filled table).
- One provider fails to parse → isolate via `allSettled`, return partial data, list skipped providers in `degraded[]` and a table footer note.
- Aggregation throw / payload-shape mismatch → `isError: true` with a clear message (incl. version-skew hint); never hang the transport.

## 9. Testing
- **Parity:** `buildUsage('today', {provider:'all'})` deep-equals current `status --format menubar-json --period today` (plus one more period). Guards the extraction.
- **Per-tool:** fixture payload → expected markdown table (snapshot) + structuredContent keys; `by` each dimension; redaction on/off (no real names/paths leak when off; pseudonyms stable); empty-state message.
- **MCP protocol smoke:** in-memory transport — `listTools` returns the 2 tools with annotations + outputSchema; call each; assert result shape (`content` + `structuredContent`) and `isError` paths; concurrent identical calls coalesce to one scan.
- **Build:** assert SDK + zod are externalized (absent from `dist`) and declared in `dependencies`.

## 10. Out of Scope (v1 — YAGNI)
- HTTP/SSE transport (stdio only).
- `compare_periods` (agent can diff two `get_usage` calls; backend is net-new and overlap-incoherent).
- Write/mutating tools, auth, multi-machine/remote data.
- MCP **prompts** and **resources** primitives (tools-only v1; revisit if a "cost-review" prompt template proves useful).
- README "MCP" section and MCP-registry listings (lobehub/Smithery/mcp.so) — follow-up tasks, not code.

## 11. Provenance — review findings incorporated
Hardened by a validator + devil's-advocate pass:
- **BLOCKER** in-process resident server (caches don't help exec-per-call) — §3, §7.
- **BLOCKER** split cheap vs optimize path (optimize ≈ 70% of cost) — §7.
- **BLOCKER** redact names by default (raw repo names + dated spend would egress) — §6.
- **MAJOR** `buildUsage/buildSavings` signature carries provider/project/range for parity — §3.
- **MAJOR** tsup `external` + deps in `dependencies`; pin SDK `^1.29.0`; add `zod` explicitly — §3.
- **MAJOR** per-provider `allSettled` isolation + `degraded[]` — §5, §8.
- **MAJOR** in-flight coalescing — §5, §7.
- **MAJOR** drop `compare_periods`; rename period enums; default `today` — §4, §10.
- **MINOR** `console.log→console.error` stdout guard; friendly empty-state; run compiled `dist` not `tsx`; validate payload shape; `last_6_months` is the real max — §3, §8, §4.
