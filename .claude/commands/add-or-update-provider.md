---
name: add-or-update-provider
description: Workflow command scaffold for add-or-update-provider in quota.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-or-update-provider

Use this workflow when working on **add-or-update-provider** in `quota`.

## Goal

Add a new AI provider integration or update provider toggling/configuration in both backend (CLI) and frontend (menubar app).

## Common Files

- `src/providers/*.ts`
- `src/providers/index.ts`
- `src/config.ts`
- `src/dashboard.tsx`
- `mac/Sources/CodeBurnMenubar/Views/SettingsView.swift`
- `mac/Sources/CodeBurnMenubar/Views/AgentTabStrip.swift`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Add or update provider implementation in src/providers (e.g., create src/providers/vertex.ts).
- Update provider registry/index (src/providers/index.ts).
- Update configuration logic to support toggling (src/config.ts, CLI commands).
- Update dashboard UI to display new provider (src/dashboard.tsx).
- Update menubar app settings UI to add toggle and settings for provider (mac/Sources/CodeBurnMenubar/Views/SettingsView.swift, AgentTabStrip.swift, AppStore.swift, CodeBurnApp.swift).

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.