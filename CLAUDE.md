# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CodeBurn is a CLI tool that shows where AI coding tokens go - by task, tool, model, and project. It reads session data directly from disk (no wrapper/proxy/API keys) for Claude Code, Codex, and Cursor. It has an interactive TUI dashboard built with Ink (React for terminals), CSV/JSON export, and a macOS menu bar widget.

## Commands

```bash
# Development (run source directly)
npx tsx src/cli.ts report          # interactive dashboard
npx tsx src/cli.ts today           # today's dashboard
npx tsx src/cli.ts report -p 30days

# Tests
npx vitest run                     # all tests
npx vitest run tests/export.test.ts  # single test file
npx vitest --watch                 # watch mode

# Build
npm run build                      # tsup -> dist/cli.js (single ESM bundle)
```

## Verification (before any commit)

- Run `npx vitest run` - all tests must pass
- Run `npx tsx src/cli.ts report` and `npx tsx src/cli.ts today` - confirm they work
- For dashboard changes: run the interactive TUI and visually confirm rendering
- For new features: test happy path AND edge cases (empty data, missing config, pipe mode)

## Architecture

**Data flow**: CLI (`cli.ts`) -> Provider discovery (`providers/index.ts`) -> Session parsing (`parser.ts`) -> Cost calculation (`models.ts`) -> Classification (`classifier.ts`) -> Output (dashboard/format/export)

**Provider plugin system**: Each provider implements the `Provider` interface in `providers/types.ts`:
- `discoverSessions()` finds session files on disk
- `createSessionParser()` returns an async generator of `ParsedProviderCall`
- Tool names are normalized so the classifier works across providers
- Cursor is lazy-loaded (optional `better-sqlite3` dep) via dynamic import in `providers/index.ts`
- To add a new provider: create `src/providers/<name>.ts` implementing the `Provider` interface, register in `providers/index.ts`

**Dashboard**: `dashboard.tsx` is an Ink (React) TUI. It renders gradient charts, responsive panels, and handles keyboard navigation. Period switching (Today/7d/30d/Month) re-parses sessions.

**Pricing**: `models.ts` fetches LiteLLM pricing JSON, caches at `~/.cache/codeburn/` for 24h. Has hardcoded fallback pricing for all Claude/GPT models to prevent fuzzy-match mispricing. Pricing model names must match LiteLLM exactly.

**Deduplication**: Each provider has its own dedup strategy (API message ID for Claude, cumulative token cross-check for Codex, conversation/timestamp for Cursor). Dedup keys are tracked in a `Set<string>` passed to each parser.

## Code Quality

- Clean, minimal code. No dead code, no commented-out blocks, no TODO placeholders
- No emoji anywhere in the codebase
- No em dashes. Use hyphens or rewrite the sentence
- No AI slop: no "streamline", "leverage", "robust", "seamless" in user-facing text
- No unnecessary abstractions. Three similar lines > premature helper function

## Accuracy

- Every user-facing number (cost, tokens, calls) must be verified against real data
- LiteLLM pricing model names must match exactly. No guessing model IDs
- Date range calculations must be tested with edge cases (month boundaries, billing day > days in month)

## Style

- TypeScript strict mode. No `any` types
- No comments unless the WHY is non-obvious
- Imports: node builtins first, then deps, then local (separated by blank line)
- Single quotes, no trailing semicolons (follow existing convention)

## Git

### Branching (strict)

- NEVER commit directly to main. All work happens on branches
- Branch naming: `feat/<name>`, `fix/<name>`, `chore/<name>`, `docs/<name>`
- Merge to main ONLY after: tests pass, CLI verified, manual testing done
- npm publish ONLY from main after merge
- Tag releases: `git tag v0.X.0` after publish

### Creating a branch

```bash
git checkout main && git pull origin main
git checkout -b feat/my-feature
# work, test, iterate
npx vitest run
npx tsx src/cli.ts report
# when ready:
git checkout main && git merge feat/my-feature
git push origin main
```

### Handling external PRs

- NEVER rewrite a contributor's changes on your own branch. Always merge THEIR branch
- Add your improvements as separate commits on top of their branch, not as replacements
- This preserves their authorship in git history so GitHub shows them as a contributor

```bash
gh pr checkout <number>           # checkout PR locally
npx vitest run                    # test their code
npx tsx src/cli.ts report         # manual verification
# apply patches if needed, commit on their branch
git checkout main
git merge <branch>                # preserves their authorship
git push origin main
gh pr comment <number> --body "Merged, thanks!"
```

### What gets committed

- Source code: `src/`, `tests/`
- Config: `package.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore`
- Docs: `README.md`, `CHANGELOG.md`, `LICENSE`, `CLAUDE.md`
- Assets: `assets/`
- NEVER commit: `.env`, secrets, keys, planning docs (`docs/superpowers/`), IDE config, logs, `.DS_Store`
- Check `git status` before every commit. Stage specific files, never `git add -A` or `git add .`

### Commit rules

- Commits from: AgentSeal <hello@agentseal.org>
- NEVER add Co-Authored-By lines
- NEVER include personal names or usernames in commits
- Small, focused commits. One feature per commit
- Test locally before every commit
