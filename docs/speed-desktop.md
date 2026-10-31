# Desktop generation speed

The Desktop **Speed** tab reads the local timing report supplied by the generation-speed CLI. It shows generation speed, first arrival, a trend with gaps for missing data, and the typical day from the preceding week. Harness and date filters apply to these timing records; usage account, project and device filters do not.

Recorded chunk arrivals can be inspected without storing or displaying their text. Missing timing stays unavailable, estimated rates are marked, and buffered delivery never appears as measured generation speed. The shared bridge exposes the same report and event inspection in the editor webview.

## CLI dependency

This UI requires the `codeburn speed --json` and `codeburn speed events` commands introduced by PR #1811. Merge the CLI layer before deploying this UI. An older CLI reports an error through the existing CLI error panel instead of fabricating results.

Capture setup and timing semantics are documented in [Generation speed by model and harness](speed.md), supplied by that CLI change.
