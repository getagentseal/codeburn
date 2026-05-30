---
name: menubar-settings-pane-refactor
description: Workflow command scaffold for menubar-settings-pane-refactor in quota.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /menubar-settings-pane-refactor

Use this workflow when working on **menubar-settings-pane-refactor** in `quota`.

## Goal

Refactor or enhance the menubar app's settings UI, especially the Providers pane/sidebar, tabs, and selection logic.

## Common Files

- `mac/Sources/CodeBurnMenubar/Views/SettingsView.swift`
- `mac/Sources/CodeBurnMenubar/CodeBurnApp.swift`
- `mac/Sources/CodeBurnMenubar/AppStore.swift`
- `mac/Sources/CodeBurnMenubar/Views/AgentTabStrip.swift`
- `mac/Sources/CodeBurnMenubar/Views/MenuBarContent.swift`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update SettingsView.swift to change sidebar structure, tabs, or navigation logic.
- Update CodeBurnApp.swift and/or AppStore.swift to support new UI logic or state.
- Update AgentTabStrip.swift or MenuBarContent.swift if tab strip or sidebar content changes.
- Test sidebar selection, tab switching, and provider toggling.
- Adjust window sizing/layout if needed.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.