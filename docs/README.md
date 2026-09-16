# Docs index

One line per file in this directory, recursively.

## docs/

- [architecture.md](architecture.md) — A map of the codebase.
- [by-branch.md](by-branch.md) — The Spend view in CodeBurn Desktop has a By branch panel: pick a project and see where its AI spend went, per git branch, with the recorded worktrees and the individual sessions behind each branch.
- [compare-cohorts.md](compare-cohorts.md) — The classic Compare view answers "how do these two models differ across my whole history?" by aggregating everything each model ever did.
- [compare-periods.md](compare-periods.md) — Compare two date ranges side by side and see exactly what drove the change in usage and cost.
- [drill-through.md](drill-through.md) — CodeBurn Desktop can open any aggregate as a session list that explains exactly what composes it, without losing your place.
- [optimize.md](optimize.md) — `codeburn optimize` scans your Claude Code sessions and your `~/.claude/` setup, reports what is costing tokens without earning them, and grades the setup A to F.

## docs/design/

- [design/capacity-dock.md](design/capacity-dock.md) — Status: implementation specification (Epic: Quota Intelligence #725).
- [design/codeburn-desktop-plan.md](design/codeburn-desktop-plan.md) — Goal: a standalone Electron desktop app that renders the approved v6 "indigo instrument" wireframes, fed entirely by spawning the `codeburn` CLI for JSON.
- [design/codeburn-desktop.md](design/codeburn-desktop.md) — Build CodeBurn Desktop, a standalone, resizable native desktop application (Electron) that renders the approved v6 "indigo instrument" wireframes.
- [design/codeburn-mcp-plan.md](design/codeburn-mcp-plan.md) — Goal: add a `codeburn mcp` stdio MCP server exposing CodeBurn's usage/cost data to AI agents via two tools (`get_usage`, `get_savings`).
- [design/codeburn-mcp.md](design/codeburn-mcp.md) — CodeBurn already aggregates rich AI-coding usage/cost data (by task, model, project, provider; retry tax; routing waste; optimize findings; 365-day history).
- [design/desktop-data-lifecycle.md](design/desktop-data-lifecycle.md) — Status: implementation contract for the quality/performance epic.
- [design/perf-cache-fix.md](design/perf-cache-fix.md) — `codeburn status --format menubar-json` was measured taking 25-90+ seconds per call, with no speedup on a repeat call against an unchanged, freshly-warmed cache.

## docs/providers/

- [providers/README.md](providers/README.md) — One file per provider integration.
- [providers/NEW_PROVIDER.md](providers/NEW_PROVIDER.md) — Guide for adding a new session-discovery provider to codeburn.
- [providers/antigravity.md](providers/antigravity.md) — Google Antigravity (CLI and IDE).
- [providers/claude.md](providers/claude.md) — Anthropic Claude Code CLI and Claude Desktop's local agent mode.
- [providers/cline-cli.md](providers/cline-cli.md) — The Cline command-line agent (npm `cline`, 3.x).
- [providers/cline.md](providers/cline.md) — Cline VS Code extension and Cline home-data task storage.
- [providers/codebuff.md](providers/codebuff.md) — Codebuff (formerly Manicode) CLI coding agent.
- [providers/codewhale.md](providers/codewhale.md) — CodeWhale CLI saved sessions.
- [providers/codex.md](providers/codex.md) — OpenAI Codex CLI.
- [providers/copilot.md](providers/copilot.md) — GitHub Copilot Chat (CLI, VS Code core chat sessions, VS Code extension transcripts, and JetBrains IDE sessions).
- [providers/crush.md](providers/crush.md) — Charmbracelet's Crush TUI coding agent.
- [providers/cursor-agent.md](providers/cursor-agent.md) — Cursor's background agent transcripts (separate from the regular chat).
- [providers/cursor.md](providers/cursor.md) — Cursor IDE chat history.
- [providers/devin.md](providers/devin.md) — Cognition Devin CLI local usage tracking.
- [providers/droid.md](providers/droid.md) — Factory's Droid CLI.
- [providers/dsh.md](providers/dsh.md) — DeepSeek's open-source agent harness (`dsh`, npm `@deepseek-ai/dsh`).
- [providers/forge.md](providers/forge.md) — Forge agent CLI.
- [providers/gemini.md](providers/gemini.md) — Google Gemini CLI.
- [providers/goose.md](providers/goose.md) — Block's Goose CLI.
- [providers/grok.md](providers/grok.md) — Grok Build, xAI's coding CLI.
- [providers/hermes.md](providers/hermes.md) — Hermes Agent CLI profiles.
- [providers/ibm-bob.md](providers/ibm-bob.md) — IBM Bob IDE task history.
- [providers/kilo-code.md](providers/kilo-code.md) — KiloCode VS Code extension.
- [providers/kimi.md](providers/kimi.md) — Kimi Code CLI session parser.
- [providers/kimicode.md](providers/kimicode.md) — MoonshotAI Kimi Code local session usage and tool activity.
- [providers/kiro.md](providers/kiro.md) — Kiro IDE chat history.
- [providers/lingtai-tui.md](providers/lingtai-tui.md) — LingTai TUI per-agent token ledger integration.
- [providers/mistral-vibe.md](providers/mistral-vibe.md) — Mistral Vibe CLI.
- [providers/mux.md](providers/mux.md) — [coder/mux](https://github.com/coder/mux), Coder's desktop/CLI app for parallel agentic development.
- [providers/omp.md](providers/omp.md) — OMP CLI.
- [providers/open-design.md](providers/open-design.md) — Open Design coding agent.
- [providers/openclaude.md](providers/openclaude.md) — OpenClaude (npm `@gitlawb/openclaude`) is a Claude Code fork that runs the same agent loop against any LLM backend.
- [providers/openclaw.md](providers/openclaw.md) — OpenClaw, plus the older Clawdbot / Moltbot / Moldbot lineage.
- [providers/opencode.md](providers/opencode.md) — OpenCode (sst/opencode).
- [providers/pi.md](providers/pi.md) — Pi agent CLI.
- [providers/quickdesk.md](providers/quickdesk.md) — Amazon Quick Desktop local usage and session history.
- [providers/qwen.md](providers/qwen.md) — Qwen Code CLI.
- [providers/roo-code.md](providers/roo-code.md) — Roo Code VS Code extension.
- [providers/vercel-gateway.md](providers/vercel-gateway.md) — Cloud usage for [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) via the reporting API.
- [providers/vscode-cline-parser.md](providers/vscode-cline-parser.md) — Shared discovery and parsing for Cline and VS Code extensions descended from Cline.
- [providers/warp.md](providers/warp.md) — Warp Oz agent sessions from Warp's local SQLite database.
- [providers/zcode.md](providers/zcode.md) — ZCode CLI coding agent (z.ai), running GLM-5.2 over the z.ai start-plan.
- [providers/zed.md](providers/zed.md) — Zed's built-in AI agent.
- [providers/zerostack.md](providers/zerostack.md) — Zerostack (gi-dellav/zerostack), a minimal Rust coding agent.

## docs/release-acceptance/

- [release-acceptance/README.md](release-acceptance/README.md) — This directory turns the August 2026 dogfood audit into a repeatable release gate.
- [release-acceptance/AGENT-RUNBOOK.md](release-acceptance/AGENT-RUNBOOK.md) — Use this contract when assigning a CodeBurn candidate to an audit agent.
- [release-acceptance/cases.csv](release-acceptance/cases.csv) — CSV, columns: id, phase, persona, surface, test, method, automation, evidence, threshold, blocking, owner.
- [release-acceptance/ledger.schema.json](release-acceptance/ledger.schema.json) — JSON Schema titled "CodeBurn release acceptance run".
- [release-acceptance/ledger/history.jsonl](release-acceptance/ledger/history.jsonl) — JSON Lines log; each line is one release-acceptance run record (run_id, verdict, surfaces, findings, evidence).
- [release-acceptance/templates/accuracy.csv](release-acceptance/templates/accuracy.csv) — CSV template, columns: run_id, case_id, persona, surface, filter, provider, session_id, expected/actual token and cost fields, status, evidence, notes.
- [release-acceptance/templates/click-through.csv](release-acceptance/templates/click-through.csv) — CSV template, columns: run_id, case_id, persona, surface, destination_or_control, prerequisites, action, resulting_state, status, feedback_ms, settled_ms, screenshot, accessibility_notes, notes.
- [release-acceptance/templates/findings.csv](release-acceptance/templates/findings.csv) — CSV template, columns: run_id, id, severity, status, confidence, frequency, persona, surface, candidate_sha, version, prerequisites, repro, expected, actual, evidence, privacy_impact, owner, size, execution_lane, acceptance_condition.
- [release-acceptance/templates/residue.csv](release-acceptance/templates/residue.csv) — CSV template, columns: run_id, kind, path, active, version, bundle_id, sha256, size_bytes, process_pid, package_manager, disposition, backup_path, notes.
- [release-acceptance/templates/timings.csv](release-acceptance/templates/timings.csv) — CSV template, columns: run_id, case_id, surface, persona, operation, trial, cache_state, start_monotonic_ms, first_feedback_ms, first_useful_ms, complete_ms, cpu_peak_pct, rss_peak_bytes, calls, tokens, cost_usd, identical_totals, notes.

## docs/sync/

- [sync/README.md](sync/README.md) — Push your AI usage telemetry to a shared backend so teams can track adoption, budgets, and ROI across developers.
- [sync/DEVELOPER.md](sync/DEVELOPER.md) — Architecture, protocol, server contract, and testing for `codeburn sync`.
