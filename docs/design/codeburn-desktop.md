# CodeBurn Desktop — Design Spec

**Date:** 2026-07-10
**Branch:** `feat/desktop-app` (cut from `origin/main`, v0.9.15)
**Design reference:** `codeburn-desktop-wireframes.html` (v6.1 "indigo instrument", repo root)
**Status:** Approved design → implementation planning

---

## 1. Summary

Build **CodeBurn Desktop** — a standalone, resizable native desktop application (Electron) that
renders the approved v6 "indigo instrument" wireframes. It is a first-class app in the vein of
Claude Desktop / the Codex app, **distinct from**:

- the `dash/` **web dashboard** (React app served by `codeburn web`) — untouched, unrelated;
- the `mac/` + `gnome/` **menubar** apps — small tray popovers.

The desktop app is local-first: it never sends data anywhere, and it does **not** re-implement
usage analytics. All aggregation stays in the `codeburn` CLI; the app is a view layer that spawns
the CLI and renders its JSON — the same contract the menubar apps use today.

## 2. Goals / Non-goals

**Goals**
- A resizable window with six sections: **Overview · Spend · Optimize · Models · Plans · Settings/Devices**.
- Pixel-faithful to the approved wireframe (the wireframe CSS is the design system, ported verbatim).
- Data via the **menubar contract**: spawn `codeburn … --json`, decode, poll on a 30s timer + on demand.
- Reuse existing CLI JSON where it exists; add small new `--json` emitters where the wireframe needs
  data that the CLI doesn't expose yet. **No faked/stubbed data in the renderer.**

**Non-goals (this milestone)**
- Signed/notarized distributable (`.dmg`/`.app`/installer). Milestone 1 runs locally (`electron .`);
  packaging (electron-builder + notarization) is an explicit follow-up.
- Touching `dash/`, `mac/`, `gnome/`, or the existing Tauri popover.
- Auto-update, telemetry, cloud sync, multi-window.

## 3. Architecture

New top-level directory `app/` in the monorepo:

```
app/
├── package.json              # own package: electron, vite, react 19, typescript
├── electron/
│   ├── main.ts               # BrowserWindow lifecycle, 30s poll timer, IPC handlers
│   ├── cli.ts                # resolve codeburn binary path + spawn `codeburn … --json` (argv, no shell)
│   └── preload.ts            # contextBridge → window.codeburn.{getOverview,getModels,getPlans,getDevices,…}
├── renderer/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx               # sidebar nav + window chrome (period/provider), section router (local state)
│   ├── styles/
│   │   └── indigo.css        # wireframe CSS ported verbatim (tokens + component classes)
│   ├── sections/
│   │   ├── Overview.tsx  Spend.tsx  Optimize.tsx  Models.tsx  Plans.tsx  Settings.tsx
│   ├── components/           # shared: Window chrome, Panel, StatCard, CapsuleChart, StackedBars,
│   │                         #         Sankey, ListRow, Track, SegTabs, etc. (extracted from wireframe)
│   ├── lib/
│   │   ├── ipc.ts            # typed wrappers over window.codeburn.*
│   │   └── types.ts          # TS types mirroring each CLI JSON payload
│   └── hooks/                # useOverview(period), useModels(), … (poll + cache)
└── vite.config.ts
```

**Process model**
- **Main process** is the only place that touches the CLI or the filesystem. It:
  - resolves the `codeburn` binary path (persisted-path file → `PATH` fallback across brew/nvm/volta/asdf,
    mirroring `mac/Sources/CodeBurnMenubar/Security/CodeburnCLI.swift`);
  - spawns `codeburn <subcommand> --json …` as plain argv (no shell), with a hard timeout (~45s) and a
    cap on concurrent spawns;
  - exposes IPC handlers per data need; re-polls every 30s and on user action (period/provider change,
    manual refresh);
  - handles the "CLI not found / non-zero exit / bad JSON" states → surfaces the wireframe's empty /
    permission-denied states (§7 "States & trust").
- **Renderer** runs with `contextIsolation: true`, `nodeIntegration: false`. It receives typed data over
  IPC and renders. No Node, no direct spawn.
- **preload** exposes a minimal, typed `window.codeburn` surface via `contextBridge`.

**Binary resolution** reuses the menubar approach; if `codeburn` cannot be found, the app shows a
first-run "point me at your codeburn CLI" state rather than crashing.

## 4. Data contract (the menubar pattern, generalized)

The app spawns the CLI per section and decodes JSON. Aggregation is 100% CLI-side.

| Section | CLI invocation | Payload | Exists today? |
|---|---|---|---|
| Overview | `codeburn status --format menubar-json --period 30days [--provider X]` | `MenubarPayload` (`src/menubar-json.ts`) | ✅ |
| Spend (bars, projects) | same `MenubarPayload` (`current.topProjects`, `history.daily`) | — | ✅ (⚠ per-model-per-day may need `history.daily` enrichment) |
| Spend (Sankey model→project) | **new** `codeburn spend --format flow-json` (or extend menubar payload) | model×project cost matrix | ⚠ **new emitter** |
| Optimize (waste) | `MenubarPayload.optimize` | findings | ✅ |
| Optimize (reverts/abandoned) | **new** `codeburn yield --json` | shipped-vs-reverted, abandoned sessions | ⚠ **new emitter** |
| Models | `codeburn models --json` | per-model table (calls/input/output/cache/cost/saved) | ✅ |
| Plans | **new** `codeburn plan --json` (list plans + usage vs cycle) | plans + progress | ⚠ **new emitter** (data exists in `src/config.ts`; needs JSON shape) |
| Settings/Devices | `codeburn devices --json` / `codeburn share status --json` (or the `origin/main` `/api/devices`,`/api/share/status` handlers as reference) | this device, discovered, paired | ✅ commands exist on main; ⚠ confirm/​add `--json` |

**Rule:** every ⚠ becomes its own CLI-side task in `src/` (TypeScript). The renderer never invents data;
if an emitter isn't ready, its section shows the wireframe's honest loading/empty state, not fake numbers.

`renderer/lib/types.ts` mirrors each payload as a hand-kept TS type (same convention `dash/` uses — no
shared type package). Where a menubar payload type already exists in `src/menubar-json.ts`, copy it.

## 5. Styling

Port the wireframe's hand-written CSS **verbatim** into `renderer/styles/indigo.css`:
- token block (`--pg / --panel / --blue / --purple / --lav / --cyan / --grad / --grad-bar / …`);
- component classes (`.win / .sb / .ni / .bar / .panel / .phead / .stat / .plot / .bars / .sbars /
  .li / .track / .seg / .pop / .btn / .rail / .mini / …`).

Each wireframe section (`<section>` blocks in the HTML) maps near-directly to a React component. Shared
repeating structures (`.panel`, `.stat`, capsule chart, stacked bars, the Sankey SVG, list rows, plan
tracks) get extracted into `renderer/components/` so the six sections compose them rather than duplicate
markup. This keeps the approved look exactly while giving each section a clean, independently-testable
boundary. **Not** rebuilding in Tailwind — that would risk drift from the approved design and cost time.

Light theme is a follow-up (wireframe notes a light ladder using the same tokens); ship dark first.

## 6. Section specs (what each renders)

1. **Overview** — 4 stat cards (Today, Month-to-date, Projected month, Waste found), the daily-spend
   capsule chart (30 bars, gradient+glow on peak), "Most expensive sessions" list. Source: `MenubarPayload`
   (`current`, `history.daily`, `topSessions`, `optimize.savingsUSD`); projected month computed from history.
2. **Spend** — lens tabs (Projects/Activity/Tools/MCP/Subagents); stacked daily-by-model bars + "By project"
   list; the **model→project Sankey** signature. Sankey needs the new flow emitter.
3. **Optimize** — segment tabs (Waste / Reverts / Abandoned / Fixes) with dollar totals; ranked findings with
   evidence (mono) + copy-fix chips. Waste from `optimize`; reverts/abandoned from new `yield --json`.
4. **Models** — pricing table with per-model series dots (calls/input/output/cache/cost/saved), unpriced-row
   "add alias" affordance, Compare mode. Source `models --json`.
5. **Plans** — vendor-cycle plan tracks (gradient fill; red past 100%), pace warnings as text. Source new
   `plan --json`.
6. **Settings/Devices** — settings rail (General/Providers/Aliases/Plans/Devices/Export/Privacy); Devices pane:
   this device, discovered-nearby (approve), paired list, "combine usage" toggle. Source devices/share JSON.
7. **States & trust** (cross-cutting) — per-provider empty/permission-denied/loading/provenance states, wired
   from CLI exit codes + partial payloads.

Window chrome (traffic lights, app mark, sidebar nav with ⌘1–⌘5 / ⌘,, period segmented control, provider
popover, ⌘K affordance, footer hints) is shared across all sections.

## 7. Task decomposition (for delegated implementation)

Fable orchestrates and reviews; implementers are **Opus 4.8 (primary)** and **Codex 5.6-high (alternate)**.

- **T0 — Scaffold** (`app/` Electron+Vite+React, main/preload/renderer, IPC bridge, `indigo.css` port,
  shared `components/`, window chrome + sidebar nav, `codeburn` path resolution + one working IPC call).
  → Opus 4.8. **Blocks all section work.**
- **T1 — CLI JSON emitters** in `src/` (TypeScript): `spend … flow-json` (Sankey matrix), `yield --json`,
  `plan --json`, confirm/add `devices/share … --json`; unit tests in `tests/`. → Codex 5.6-high. Parallel with T0.
- **T2 Overview**, **T3 Spend**, **T4 Optimize**, **T5 Models**, **T6 Plans**, **T7 Settings/Devices** — one
  self-contained component + typed hook each. Split across Opus 4.8 + Codex 5.6-high. Each depends on T0;
  T3/T4/T6/T7 also depend on their T1 emitter (mock the typed payload until the emitter lands, then swap).
- **T8 — Integration pass**: 30s polling, refresh-on-action, error/empty/loading states end-to-end,
  README + `npm run app:dev`. → Opus 4.8.

Every returned unit comes back to Fable for review before it counts as done.

## 8. Milestones

- **M1 (this effort):** app runs via `electron .` (dev), all six sections rendering real CLI data (⚠ gaps
  filled by T1 emitters), dark theme, honest states. No packaging.
- **M2 (follow-up):** electron-builder packaging, code-sign + notarize, `codeburn app` launcher subcommand
  (mirroring `codeburn menubar`), auto-update, light theme.

## 9. Testing / verification

- **CLI emitters (T1):** vitest in `tests/` against fixtures (the repo's established pattern).
- **Renderer:** component render tests for each section against typed mock payloads (Vitest + RTL; add to
  `app/`). Typecheck via `tsc --noEmit`.
- **End-to-end smoke:** launch `electron .` against real local session data; verify each section populates,
  period/provider switching re-polls, and CLI-missing → first-run state. Verified by Fable before sign-off.

## 10. Risks / open items

- **Data-shape drift:** hand-kept types between `src/` and `app/` can diverge (same risk `dash/` carries).
  Mitigation: copy menubar types verbatim; T1 emitters ship with typed fixtures the renderer reuses.
- **Sankey matrix cost:** model×project aggregation may be non-trivial in `usage-aggregator.ts`; if it slips,
  Spend ships bars+projects first and the Sankey lands in a fast follow.
- **Provider-name / project-path privacy:** local app shows real project names (unlike shared/sanitized data);
  fine for a local-only window, but keep the sanitize boundary in mind for any future device-pull views.
- **Electron version / security defaults:** pin Electron, enable `contextIsolation`, disable `nodeIntegration`,
  restrict `preload` surface; no remote content loaded.
```
