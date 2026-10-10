# Changelog

## 1.0.0

First release of the CodeBurn extension for VS Code and its forks (Cursor, Windsurf, Antigravity, VSCodium).

- Status bar item with today's spend, `~` for partly estimated figures, and a tooltip with the week, the month, this workspace, the top model and plan quotas.
- Activity bar summary: this workspace, all projects, top projects and models, quota bars, Optimize findings.
- The full desktop dashboard in an editor tab, scoped to the current workspace or to all projects.
- Commands: Open Dashboard, Refresh, Show Today, Show This Workspace, Show All Projects, Open Optimize, Copy Summary, Open Settings, Star on GitHub.
- Settings for the default period, refresh interval, status bar format, currency, provider, quota providers and Node.js path.
- Follows the editor's theme (light, dark, high contrast) and display language (six languages).
- Headline totals carry `~` when more than 1% of the figure is estimated.
- Bundles CodeBurn CLI 0.9.26; no telemetry. The extension keeps its own version, and Settings shows the CLI version next to it.
