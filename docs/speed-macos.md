# macOS generation speed summaries

The macOS menubar shows a **Generation speed** summary for the last 24 hours on this device. Capacity Dock adds the selected harness's latest model to its glance panel. Both use the CLI report, show estimates and unavailable values explicitly, compare against the preceding week's typical day, and retain a marked stale snapshot if a refresh fails.

Refresh runs independently of usage and quota scans, with a bounded cadence and one in-flight request. Cancellation prevents late responses from replacing a newer state. The Desktop Speed tab provides the full timeline and history.

## CLI dependency and merge order

These summaries require `codeburn speed --json` from PR #1811. Merge the CLI layer first, then the Desktop Speed layer, and then these native summaries. A missing or failing CLI leaves speed unavailable, or marks the retained prior snapshot as stale.

Capture setup and timing semantics are documented in [Generation speed by model and harness](speed.md), supplied by the CLI change.
