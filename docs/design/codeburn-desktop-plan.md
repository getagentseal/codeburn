# CodeBurn Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task runs its own TDD cycle (write failing test → confirm red → implement → confirm green → commit).

**Goal:** A standalone Electron desktop app that renders the approved v6 "indigo instrument" wireframes, fed entirely by spawning the `codeburn` CLI for JSON.

**Architecture:** New `app/` workspace. Electron **main** process resolves + spawns `codeburn <sub> --format json|menubar-json` (plain argv, no shell), decodes typed payloads, pushes to the **renderer** (React 19 + Vite) over a typed `contextBridge` IPC surface, and re-polls on a 30s timer + on demand. All aggregation stays CLI-side; the renderer is a pure view and never fabricates data. Wireframe CSS is ported verbatim as the design system.

**Tech Stack:** Electron, TypeScript, React 19, Vite 6, Vitest + React Testing Library. Data via `codeburn` CLI subprocess. No new runtime deps in the CLI beyond the two small JSON emitters (T1).

**Design source of truth:** `codeburn-desktop-wireframes.html` (repo root). Each renderer section is a near-verbatim port of the matching `<section>` block; do not redesign.

**Spec:** `docs/design/codeburn-desktop.md`.

## Global Constraints

- **Do not modify** `dash/`, `mac/`, `gnome/`, `appstore/`, or the gitignored `desktop/` Tauri experiment. New code lives in `app/` (renderer/main) and `src/` (only the two T1 emitters + their tests).
- **Electron security:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` where feasible; renderer gets Node access ONLY through the typed `preload` bridge. No remote content loaded — renderer is local files only.
- **Data contract = spawn CLI, decode JSON, poll.** No HTTP server, no daemon, no importing `src/` into the app. Never render fabricated numbers; missing/failed data → the wireframe's honest loading/empty/permission states.
- **Binary resolution** mirrors the mac app: resolve `codeburn` via a persisted path file, then `PATH` search (brew/nvm/volta/asdf), then a first-run "locate CLI" state. Reference: `mac/Sources/CodeBurnMenubar/Security/CodeburnCLI.swift`.
- **Poll cadence:** 30s timer + immediate refresh on period/provider change and manual refresh; hard per-spawn timeout ~45s; cap concurrent spawns.
- **Theme:** dark only this milestone (light is M2).
- **Packaging:** none this milestone — app runs via `npm --prefix app run dev` (Vite + Electron). Signing/notarization/`codeburn app` launcher are M2.
- **Repo pattern:** `app/` is a standalone package (own `package.json`), like `dash/`. No npm workspaces exist. Hook into root `build` via a `build:app` script only in M2; M1 stays self-contained.
- **CLI subcommand flags are `--format json`, not `--json`.** Exact commands are in the Data Contract table below.

---

## Shared Interface Contracts

These are defined once and referenced by every task. Implementers must use these exact names/types.

### CLI data contract (what main spawns)

| Need | Command (argv) | Payload type | Source | New? |
|---|---|---|---|---|
| Overview + Spend bars | `codeburn status --format menubar-json --period <p> [--provider <x>]` | `MenubarPayload` | `src/menubar-json.ts:80` | existing |
| Plans pacing | `codeburn status --format json --period <p>` | JSON incl. `plan` summaries (`PlanUsage`) | `src/plan-usage.ts:110`, wired `src/main.ts:773` | existing |
| Models table | `codeburn models --format json --period <p> [--provider <x>] [--by-task]` | `ModelReportRow[]` | `src/models-report.ts:9,551` | existing |
| Optimize reverts/abandoned | `codeburn yield --format json --period <p>` | `YieldJsonReport` | `src/yield.ts:247` | existing |
| Spend Sankey (model×project) | `codeburn spend --format flow-json --period <p> [--provider <x>]` | `SpendFlow` (T1a) | new — `src/spend-flow.ts` | **T1a** |
| Settings/Devices | `codeburn devices --format json --period <p>` / `codeburn share status --format json` | `CombinedUsage` / `ShareStatus` / `Identity` / scan list | `src/menubar-json.ts:99`, `src/sharing/*` | **T1b** |

`<p>` ∈ `today | week | 30days | month | all` (wireframe "Today/7D/30D/Month/6M/Custom" maps to these; `6M`/`Custom` use `--from/--to`).

Types to mirror verbatim into `app/renderer/lib/types.ts` (copy from the cited files — do not invent):
- `MenubarPayload`, `DailyHistoryEntry`, `DailyModelBreakdown`, `CombinedUsage`, `DeviceSummary` — `src/menubar-json.ts`.
- `ModelReportRow` — `src/models-report.ts:9`.
- `YieldJsonReport` — `src/yield.ts:247`.
- `PlanUsage` — `src/plan-usage.ts` (only the fields the Plans section renders: `plan, periodStart, periodEnd, spentApiEquivalentUsd, budgetUsd, percentUsed, status, projectedMonthUsd, daysUntilReset`).
- `SpendFlow`, `ShareStatus`, `Identity`, scan entry — defined by T1a/T1b below.

### IPC surface (preload `contextBridge`)

`app/electron/preload.ts` exposes exactly this on `window.codeburn`; `app/renderer/lib/ipc.ts` wraps it 1:1 with the mirrored types:

```ts
export interface CodeburnBridge {
  getOverview(period: Period, provider: string): Promise<MenubarPayload>   // status --format menubar-json
  getPlans(period: Period): Promise<StatusJson>                            // status --format json (plan summaries)
  getModels(period: Period, provider: string, byTask: boolean): Promise<ModelReportRow[]>
  getYield(period: Period): Promise<YieldJsonReport>
  getSpendFlow(period: Period, provider: string): Promise<SpendFlow>       // T1a
  getDevices(period: Period): Promise<CombinedUsage>                       // T1b
  getShareStatus(): Promise<ShareStatus>                                   // T1b
  getIdentity(): Promise<Identity>                                         // T1b
  cliStatus(): Promise<{ found: boolean; path: string | null; error?: string }>
}
export type Period = 'today' | 'week' | '30days' | 'month' | 'all'
```

Each method rejects with a structured `CliError { kind: 'not-found' | 'nonzero' | 'bad-json' | 'timeout'; message: string }` so sections can render the right empty/permission state. Channel names: `codeburn:getOverview`, etc. (one per method).

### Section → data map (for the six section tasks)

| Section (wireframe `<section>`) | Bridge call(s) |
|---|---|
| 01 Overview | `getOverview` |
| 02 Spend | `getOverview` (bars, projects) + `getSpendFlow` (Sankey) |
| 03 Optimize | `getOverview` (`optimize` waste) + `getYield` (reverts/abandoned) |
| 04 Models | `getModels` |
| 05 Plans | `getPlans` |
| 06 Settings/Devices | `getIdentity` + `getDevices` + `getShareStatus` |

---

## File Structure

```
app/
├── package.json                 # electron, vite, @vitejs/plugin-react, react, react-dom, typescript, vitest, @testing-library/react, jsdom
├── tsconfig.json
├── vite.config.ts               # base './', react plugin, build → app/dist/renderer
├── electron/
│   ├── main.ts                  # BrowserWindow, 30s timer, ipcMain handlers → spawnCli
│   ├── cli.ts                   # resolveCodeburnPath() + spawnCli(args): argv, no shell, timeout
│   └── preload.ts               # contextBridge → window.codeburn (CodeburnBridge)
├── renderer/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx                  # sidebar nav + window chrome + section switch (local state)
│   ├── styles/indigo.css        # ported wireframe CSS (tokens + classes)
│   ├── lib/{ipc.ts,types.ts}
│   ├── hooks/usePolled.ts       # generic 30s poll + loading/error state
│   ├── components/              # Window, Sidebar, TopBar, Panel, Stat, CapsuleChart,
│   │                           #   StackedBars, Sankey, ListRow, Track, SegTabs, ProviderPop, Hint
│   └── sections/               # Overview, Spend, Optimize, Models, Plans, Settings (+ tests co-located)
│   └── test/setup.ts            # RTL + jsdom
└── (no changes to root package.json this milestone)

src/                             # CLI — T1 only
├── spend-flow.ts                # T1a: computeSpendFlow() + SpendFlow type
├── main.ts                      # T1a: register `spend` command; T1b: add --format json to devices/share
└── sharing/…                    # T1b: json serializers (thin)
tests/
├── spend-flow.test.ts           # T1a
└── devices-json.test.ts         # T1b
```

---

## Task 0 — Scaffold + shell (BLOCKS ALL) · **Opus 4.8**

**Files:**
- Create: `app/package.json`, `app/tsconfig.json`, `app/vite.config.ts`, `app/renderer/index.html`, `app/renderer/main.tsx`, `app/renderer/App.tsx`, `app/renderer/styles/indigo.css`, `app/electron/{main,cli,preload}.ts`, `app/renderer/lib/{ipc,types}.ts`, `app/renderer/hooks/usePolled.ts`, `app/renderer/test/setup.ts`
- Create components: `app/renderer/components/{Window,Sidebar,TopBar,Panel,Stat,SegTabs,ProviderPop,Hint}.tsx`
- Test: `app/electron/cli.test.ts`, `app/renderer/components/Sidebar.test.tsx`

**Interfaces:**
- Produces: the full `CodeburnBridge` (stubbed handlers that actually spawn for `getOverview`/`cliStatus`; other methods wired but may throw `not-found` until their emitter lands), `resolveCodeburnPath()`, `spawnCli(args, {timeoutMs}): Promise<unknown>`, `usePolled(fetcher, deps)`, and all shared `components/` + `styles/indigo.css`. Every later task consumes these.

**Steps:**
- [ ] **1. Port CSS.** Copy the `<style>` block from `codeburn-desktop-wireframes.html` into `renderer/styles/indigo.css` verbatim (tokens + all `.win/.sb/.ni/.bar/.panel/.phead/.stat/.plot/.bars/.sbars/.li/.track/.seg/.pop/.btn/.rail/.mini/.hint/.footer` rules). No edits beyond removing the page-level `.page/header/.toks/.principles` doc-chrome rules not used by the app window.
- [ ] **2. `spawnCli` failing test** (`app/electron/cli.test.ts`): given a fake binary that prints `{"ok":1}`, `spawnCli(['status'])` resolves to `{ok:1}`; a nonzero-exit binary rejects with `CliError{kind:'nonzero'}`; non-JSON stdout rejects `bad-json`; a hanging binary rejects `timeout`. Run → red.
- [ ] **3. Implement `cli.ts`**: `resolveCodeburnPath()` (persisted-path file → `PATH`/brew/nvm/volta/asdf → null) and `spawnCli` (`child_process.spawn`, argv, no shell, collect stdout, timeout kill, `JSON.parse`). Run → green. Commit.
- [ ] **4. Electron shell:** `main.ts` creates a ~1200×820 `BrowserWindow` (`contextIsolation:true`, `nodeIntegration:false`, preload), loads Vite dev URL / built `dist/renderer/index.html`; registers `ipcMain.handle` for each `CodeburnBridge` channel delegating to `spawnCli`; starts a 30s interval that emits a `refresh` event. `preload.ts` exposes `window.codeburn` via `contextBridge`. `ipc.ts` wraps it with types.
- [ ] **5. Window chrome + nav:** `App.tsx` renders `<Window>` = `<Sidebar>` (traffic lights, gradient CodeBurn mark, nav items Overview/Spend/Optimize/Models/Plans/Settings with ⌘1–⌘5/⌘, keycaps, active-rail gradient, status line) + content area with `<TopBar>` (title, scope caption, period `SegTabs` Today/7D/30D/Month/6M/Custom, provider `ProviderPop`) + a section outlet switched by local `section` state. Match wireframe markup/classes exactly.
- [ ] **6. Sidebar test** (`Sidebar.test.tsx`): renders 6 nav items; clicking "Spend" calls the `onNavigate('spend')` prop; active item has class `on`. Red → implement → green.
- [ ] **7. Smoke:** `npm --prefix app run dev` opens the window showing the shell + an Overview placeholder that calls `getOverview('30days','all')` and renders the raw `current.cost` (proves the end-to-end spawn→IPC→render path). If `codeburn` isn't found, the first-run "locate CLI" state shows instead. Commit.

**Acceptance (Fable review):** window launches; sidebar nav switches sections; `getOverview` round-trips real CLI JSON to the renderer; CLI-missing shows first-run state, not a crash; `contextIsolation` on, no `nodeIntegration`. `tsc --noEmit` + `vitest` green.

---

## Task 1a — CLI `spend --format flow-json` (model×project matrix) · **Codex 5.6-high**

**Files:** Create `src/spend-flow.ts`; Modify `src/main.ts` (register `spend` command); Test `tests/spend-flow.test.ts`.

**Interfaces — Produces:**
```ts
// src/spend-flow.ts
export type SpendFlowNode = { id: string; label: string; cost: number }   // models on left, projects on right
export type SpendFlowLink = { model: string; project: string; cost: number }
export type SpendFlow = { period: { label: string; start: string; end: string }
  models: SpendFlowNode[]; projects: SpendFlowNode[]; links: SpendFlowLink[] }
export async function computeSpendFlow(range: DateRange, provider: string): Promise<SpendFlow>
```
Build by iterating `parseAllSessions(range, provider)` → each `ProjectSummary.project` → each `session.modelBreakdown[model].costUSD`, accumulating a `Map<project, Map<model, cost>>` (uncapped; mirror `src/usage-aggregator.ts:34-40` but keyed by project×model). Sort nodes by cost desc; optionally roll models/projects beyond top-N into an `"other"` node (keep top 8 each, rest → `other`, so the Sankey stays legible — **log/emit the rollup, don't silently drop**).

**Steps:**
- [ ] **1.** Failing test: fixture with 2 projects × 3 models of known costs → `computeSpendFlow` returns links summing to each model's and project's total; totals equal `sum(all sessions costUSD)`. Red.
- [ ] **2.** Implement `computeSpendFlow`. Green.
- [ ] **3.** Register `program.command('spend').option('--format <f>','flow-json'|... ).option('-p,--period').option('--provider').option('--from/--to')` → prints `JSON.stringify(await computeSpendFlow(range, provider))`. Follow the exact option/`assertFormat` pattern of the `yield` command (`src/main.ts:1526`).
- [ ] **4.** Test the command wiring (invoke handler, assert JSON parses to `SpendFlow`). Green. Commit.

**Acceptance (Fable review):** `codeburn spend --format flow-json --period 30days` prints valid `SpendFlow`; link costs reconcile to model and project totals; top-N rollup labeled; vitest green; no change to any existing command's output.

---

## Task 1b — `devices` / `share` `--format json` · **Codex 5.6-high**

**Files:** Modify `src/main.ts` (`devices`, `share` commands), add thin serializers in `src/sharing/` as needed; Test `tests/devices-json.test.ts`.

**Interfaces — Produces** (reuse existing types; just serialize):
- `codeburn devices --format json` → `CombinedUsage` (`src/menubar-json.ts:99`) via existing `pullDevices()`/`summarizeDeviceUsage()`.
- `codeburn share status --format json` → `ShareStatus` (`src/sharing/share-controller.ts:139`): `{ sharing, name, port, always, peers, pending: {id,name,code}[] }`. (Add a `status` action to the `share` command if absent; read-only.)
- `codeburn identity --format json` (or `devices --format json` include an `identity` field) → `Identity` public subset `{ name, fingerprint }` (`src/sharing/identity.ts`).
- Discovered-nearby: `codeburn devices scan --format json` → `{ found: {name,host,port,fingerprint,code,paired}[] }` (mirror `/api/devices/scan`, `src/web-dashboard.ts:235`).

Match the HTTP shapes in `src/web-dashboard.ts` exactly so the app and web dashboard agree. **Read-only** — pairing/approve/pull *mutations* are out of scope for M1 (the Settings section renders these as disabled/"M2" affordances).

**Steps:**
- [ ] **1.** Failing test: `devices --format json` with no paired devices returns `CombinedUsage` with `perDevice:[<local>]`. Red.
- [ ] **2.** Add `--format json` branches (`assertFormat(['text','json'])`) to `devices` (+ `scan` action) and `share status`; wire `identity`. Green.
- [ ] **3.** Test each returns the documented shape. Commit.

**Acceptance (Fable review):** the four read commands print JSON matching the `/api/*` reference shapes; text output unchanged when `--format` omitted; vitest green.

---

## Tasks 2–7 — the six sections

**Common structure for each section task:**
- **Files:** Create `app/renderer/sections/<Name>.tsx` + `<Name>.test.tsx`; add section-specific `components/` (e.g. `CapsuleChart`, `StackedBars`, `Sankey`, `ListRow`, `Track`) where the wireframe uses them.
- **Consumes:** the shared `components/`, `styles/indigo.css`, `usePolled`, and its bridge call(s) per the Section→data map.
- **Method:** port the matching wireframe `<section>`'s markup into React verbatim (same classes), replace static numbers with fields from the typed payload, drive loading/empty/error via the section's `usePolled` state.
- **TDD per task:** (1) render test with a typed **mock** payload asserting key cells appear (e.g. Overview shows `current.cost` as `$X`, top session titles render); (2) red; (3) implement; (4) green; (5) commit. Mocks use the real mirrored types so they can't drift.
- **Acceptance (Fable review):** pixel-faithful to the wireframe section; every rendered number traces to a payload field (no literals from the mock leaking as hardcodes); loading/empty/permission states present; `tsc --noEmit` + section tests green.

### Task 2 — Overview · **Opus 4.8**
4 stat cards (Today, Month-to-date `+% vs pace`, Projected month `est`, Waste found `/wk`), the 30-bar **CapsuleChart** (gradient+glow peak, plain-blue 2nd), "Most expensive sessions" list with model series dots. Data: `getOverview`; projected-month + %-vs-pace computed from `history.daily` (document the formula in-code). Build `CapsuleChart`, `Stat`, `ListRow`, `mdot`.

### Task 3 — Spend · **Codex 5.6-high** (depends on T1a)
Lens `SegTabs` (Projects/Activity/Tools/MCP/Subagents — Projects active; others render from payload arrays where present, else empty state). **StackedBars** daily-by-model from `history.daily[].topModels` (note the top-5/day cap; add an "other" bar only if data supports it), "By project" list, and the **Sankey** (`getSpendFlow`) as the SVG signature (ribbons inherit model series hue, fade to project side). Build `StackedBars`, `Sankey`.

### Task 4 — Optimize · **Opus 4.8**
Segment tabs with dollar totals (Waste / Reverts / Abandoned / Fixes). Waste findings from `getOverview().optimize.topFindings` (title, impact, savings) with evidence + copy-fix chips; Reverts/Abandoned from `getYield()` (`summary.reverted`, `summary.abandoned`, `details[]`). Series/mint dollar styling per wireframe.

### Task 5 — Models · **Codex 5.6-high**
Pricing table with per-model series dots (`getModels`): calls/input/output/cacheRead/cost/saved(`savingsUSD`); unpriced rows (`credits`/zero cost) show the "add alias" affordance; By-model / By-task `SegTabs` (`byTask` → re-fetch with `--by-task`); "Compare…" button is a visual affordance (M2 for the compare sheet). Build `SeriesDot`, table styles.

### Task 6 — Plans · **Opus 4.8**
Plan `Track`s (gradient fill; switch to red gradient + show overage $ past 100%), pace line as text (amber "on pace to exceed", mint "on track") from `getPlans()` → per-plan `PlanUsage` (`percentUsed`, `status`, `projectedMonthUsd`, `daysUntilReset`, cycle `periodStart/End`). "Add plan…" is a visual affordance (mutation = M2). Build `Track`, `plrow`.

### Task 7 — Settings/Devices · **Codex 5.6-high** (depends on T1b)
Settings `rail` (General/Providers/Model aliases/Plans/Devices/Export/Privacy — Devices active). Devices pane: **This device** (`getIdentity` name + `codeburn-mbp.local`), **Discovered nearby** (`getDevices`/scan → approve button *disabled/M2*), **Paired** (`getDevices` → `perDevice`, cost/sessions; "Pull now"/visibility/combine toggles are visual, mutations M2). Build `rail`, `tglon` toggle. Read-only per Global Constraints.

---

## Task 8 — Integration + states + docs · **Opus 4.8**

**Files:** Modify `app/electron/main.ts` (wire 30s refresh to all sections), `app/renderer/App.tsx` (period/provider propagation, manual refresh), add `app/renderer/sections/States.tsx` (the wireframe "07 States & trust" mini-cards) if surfacing globally; Create `app/README.md`.

**Steps:**
- [ ] **1.** Propagate `period`/`provider` from `TopBar` into every section's `usePolled` deps so changing them re-polls all visible data.
- [ ] **2.** Wire the main-process 30s timer to trigger renderer refetch (event → `usePolled` revalidate); add manual "refresh" (⌘R / footer "refreshed Ns ago").
- [ ] **3.** End-to-end empty/permission/loading states: CLI-not-found → first-run; per-provider permission-denied (nonzero exit mentioning a provider) → the wireframe "permission denied — grant Full Disk Access" mini; empty range → empty state.
- [ ] **4.** `README.md`: how to run (`npm --prefix app install && npm --prefix app run dev`), the CLI dependency, the data contract, and the M2 backlog (packaging, mutations, compare sheet, light theme).
- [ ] **5.** Full smoke against real local data across all six sections + period/provider switching. Commit.

**Acceptance (Fable review):** all six sections populate from real CLI data; period/provider switching re-polls; 30s auto-refresh works; every honest state reachable; README accurate; `tsc --noEmit` + `vitest` green across `app/` and `src/`.

---

## Dependency order

```
T0 (scaffold) ─┬─> T2 Overview      T1a ──> T3 Spend
               ├─> T4 Optimize      T1b ──> T7 Settings
               ├─> T5 Models
               ├─> T6 Plans
               └─> (all) ──> T8 Integration
T1a, T1b run in parallel with T0 (no dependency on app/).
```
T0 must land before any section. T3 needs T1a; T7 needs T1b (until then they mock the typed payload). T8 last.

## Self-Review

- **Spec coverage:** §3 architecture → T0; §4 data table → contract table + T1a/T1b (spec's "yield/plan new emitters" corrected to existing commands); §5 CSS port → T0 step 1; §6 all six sections + states → T2–T8; §7 decomposition → tasks with the same model assignments; §8 M1 scope (runs, no packaging) → Global Constraints + T8. No spec requirement is unmapped.
- **Placeholder scan:** the "M2" affordances (compare sheet, pairing mutations, add-plan) are explicit deferrals with a home in the README backlog, not vague TODOs. Every task has concrete files, types, and acceptance.
- **Type consistency:** one `CodeburnBridge` + one `Period` union used everywhere; payload types are copied from cited `src/` files, not re-declared; `getSpendFlow→SpendFlow` (T1a) and `getDevices→CombinedUsage`/`getShareStatus→ShareStatus` (T1b) names match between contract, IPC surface, and tasks.

## Execution Handoff

Per the user's directive: **subagent-driven** — Fable dispatches a fresh implementer per task (Opus 4.8 primary, Codex 5.6-high for T1a/T1b/T3/T5/T7), reviews each return before it counts as done. T0 + T1a + T1b start first (T1s parallel to T0); sections fan out once T0 lands.
