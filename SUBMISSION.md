# Submission Statement

## Proposed title

Add Bahulam Code provider

## Summary

This pull request adds Bahulam Code as a first-class CodeBurn provider and includes fixture coverage for discovery, parsing, cost semantics, model attribution, tool capture, project attribution, and provider cache invalidation.

Disclosure: I maintain Bahulam Code. This PR adds CodeBurn support for a tool I publish.

### Core behavior

1. **Cost semantics**: Distinguishes "cost reported as $0" (metered free call) from "cost absent" (no cost field). Uses `isReportedCost` presence check matching the cline-cli pattern. Reported zero-cost calls preserve `costUSD: 0` with `costIsEstimated: false`. Absent cost triggers `calculateCost` with `costIsEstimated: true`. Negative costs (invalid) are treated as absent.

2. **Multi-model attribution**: When `usage.models` contains multiple entries, the parser emits one `ParsedProviderCall` per model entry with that model's own token counts, cache stats, and cost. Model rows share a single turn id so CodeBurn keeps them as one user turn.

3. **Tool events**: `tool_call`/`tool_request` events are accumulated between `complete` events. Tool names and bash commands (via `extractBashCommands`) are attached to the subsequent `complete` yield.

4. **CWD / project attribution**: `workingDirectory` and `projectPath` are set from the first `cwd` seen in the session. Source project remains the directory slug for backward compatibility.

### New files

5. **`tests/providers/bahulam.test.ts`**: Full fixture test suite covering discovery, parsing, cost semantics, multi-model, cwd attribution, probeRoots, tool extraction, deduplication, corrupt-file resilience, and session_info model resolution.

### Documentation

6. **`docs/providers/README.md`**: Bahulam row added to eager provider index (alphabetical, before Claude).
7. **`README.md`**: Bahulam Code link added to supported-tools section using `assets/providers/bahulam.png`.
8. **`SUBMISSION.md`**: Updated with current PR context.

## User-visible behavior

- `codeburn --provider bahulam` and all report commands can read Bahulam Code sessions from disk.
- Reported Bahulam costs are preserved when present, including `$0` calls.
- Calls with multiple model rows are attributed per model while remaining one user turn.
- Tool and shell-command usage from Bahulam events appears in CodeBurn's tool/activity views.
- `codeburn doctor` can show the resolved Bahulam projects root.

## Validation

- `npx vitest run tests/providers/bahulam.test.ts tests/provider-env-declarations.test.ts`: **30/30 passed**
- `npx tsc --noEmit`: passed
- `git diff --check`: passed
- Real-session smoke test: `npm run dev -- today --provider bahulam` completed and detected Bahulam usage: 6 sessions, 61 calls, and model rows for DeepSeek v4 Flash, MiMo v2.5, and DeepSeek v4 Pro.
- Real-session smoke test: `npm run dev -- models --provider bahulam` completed and showed Bahulam Code model aggregation for DeepSeek v4 Flash, MiMo v2.5, and DeepSeek v4 Pro.

## Deliberate non-changes

- Bahulam remains an eager provider because it has no heavyweight optional dependencies.
- The provider keeps the legacy `kepler_event` top-level event type for backward-compatible session parsing.
- README includes the Bahulam Code provider logo asset.

## Reviewer focus

The highest-value review is the provider parser contract: reported-cost presence semantics, multi-model turn grouping, and tool attribution from `tool_call` / `tool_request` events.
