# Contributing to CodeBurn

Thanks for your interest. This document covers what you need to know to send a working pull request.

## Prerequisites

- Node.js 22.20 or newer (`engines.node` in `package.json`).
- npm 10 or newer (ships with recent Node).
- macOS or Linux for full provider coverage. Windows works for most providers but Cursor / Antigravity development is easier on macOS.
- Optional: Swift 6 toolchain if you are touching the macOS menubar (`mac/`).
- Optional: GNOME 45 or newer if you are touching the GNOME extension (`gnome/`).

## Setup

```bash
git clone https://github.com/getagentseal/codeburn
cd codeburn
npm install
```

There is no separate build step required to run the dev CLI. `npm run dev` runs `tsx` against `src/cli.ts` directly.

## Common Commands

| Command | What it does |
|---|---|
| `npm test` | Runs the vitest suite under `tests/` (261 of the 265 files, 3,495 tests). |
| `npm run test:locks` | Runs the four parallelism-sensitive `cache-refresh-lock` suites serially. |
| `npm run test:watch` | Same scope as `npm test`, in watch mode. |
| `npm run dev -- status` | Runs the CLI in dev mode against your real data. |
| `npm run build` | Bundles the litellm pricing snapshot, then runs `tsup` to produce `dist/cli.js`. |
| `npm run bundle-litellm` | Refreshes `src/data/litellm-snapshot.json` from the upstream litellm repo. |

To test a specific suite, run vitest directly with a path:

```bash
npx vitest run tests/providers/codex.test.ts
```

`npm test` is scoped to `tests/` on purpose. The Electron app under `app/` carries its
own vitest config and its own `jsdom` dependency in `app/node_modules`; letting vitest's
default glob reach those specs from a root install fails with
`ERR_MODULE_NOT_FOUND: jsdom`. To run the app's tests, install and run them from `app/`.

## What to Read Before Editing

- `docs/architecture.md` for the high-level codebase map.
- `docs/providers/<name>.md` for the provider you intend to change.
- `RELEASING.md` if you are touching version bumps or the release pipeline.
- `SECURITY.md` for the disclosure policy.

## Project Layout

```
src/                CLI, parsers, optimize detectors, cache layers
src/providers/      One file per AI tool integration
src/data/           Bundled litellm pricing snapshot
tests/              vitest specs
mac/                Swift menubar app
gnome/              GNOME shell extension
scripts/            Build helpers (litellm bundle)
```

See `docs/architecture.md` for a fuller map.

## Coding Conventions

- TypeScript strict mode is on. Do not introduce `any` without a comment explaining why.
- Avoid bracket-assign (`obj[key] = value`) on parsed user input in hot paths inside `src/providers/` and `src/parser.ts`. There is a Semgrep rule (`.semgrep/rules/no-bracket-assign-hot-paths.yml`) enforced in CI that will fail your PR if you do. Use a `Map` or an explicit allowlist instead.
- Provider parsers must be deterministic given the same input. If you read the system clock or the filesystem outside the documented session paths, add a fixture-based test.
- New providers go through `src/providers/index.ts`. Lazy-load anything that pulls a heavy native dependency (sqlite, protobuf) so users without that provider are not slowed down.

## Tests

- Each new provider should ship with a fixture-based test under `tests/providers/`. The three providers without test files today (claude, goose, qwen) are a known gap; new code should not add to that list.
- Each new optimize detector in `src/optimize.ts` needs at least one positive and one negative case in `tests/optimize.test.ts`.
- If your change affects the menubar JSON contract, update `tests/menubar-json.test.ts`.
- A new test that exercises the cross-process refresh lock must be named
  `tests/cache-refresh-lock-<what>.test.ts` **and** added to the `test:locks` script in
  `package.json`. `npm test` excludes that prefix, so a lock test placed anywhere else
  runs under the full worker pool and fails intermittently; one that matches the prefix
  but is missing from `test:locks` never runs at all.

### The full suite is the gate

Before opening or updating a PR, run `npx vitest run` on your branch and on `main`, and compare. Your branch must introduce zero new failures. Listing only your own new tests as verification is not verification; the regressions we catch are almost always in tests the author never ran. For `mac/` changes the same applies to `swift test`.

## Commit Message Format

Short imperative subject, optional body. Examples from `git log`:

```
Enhance GNOME extension with scrollable UI, dark mode, charts, and performance fixes
Add table column headers, oneshot placeholder, currency picker dropdown
```

### No AI Co-Author Trailers

The `.github/workflows/block-claude-coauthor.yml` workflow rejects any PR whose commits contain a `Co-authored-by: ... claude ...` or `... anthropic ...` trailer. You may use AI tools to help write code, but strip the co-author line before pushing.

If a flagged PR rejects on this check, the workflow prints the exact rebase command to fix it.

## Before You Start

**Comment on the issue first.** Before writing code for a feature or new provider, leave a comment on the relevant issue saying what you plan to do. Wait for a maintainer to confirm the approach. Unsolicited PRs that duplicate work already in progress or take an incompatible approach will be closed.

**One PR at a time.** We will not review a second PR from you until the first is merged or closed. This keeps the review queue manageable and ensures each contribution gets proper attention.

**Respond to review before writing more code.** If a maintainer posts findings on your PR, nothing new from you gets reviewed until you have addressed or answered them. Do not open PRs stacked on top of a branch with an unanswered review or known failing tests; a fix that lands above the bug it fixes means the PR below it was never mergeable.

**You are accountable for what your agent submits.** Using AI agents to write PRs is fine; we do it too. But every PR carries your name, and "my agent generated it" is not a response to review findings. If your agent produces PRs faster than you can verify them against the full suite, slow the agent down.

## Adding a New Provider

New providers have the highest bar because broken parsing silently produces wrong data for users. Before opening a PR:

1. **Install the tool and use it.** Generate real sessions by actually coding with the provider. We do this ourselves for every provider we ship.
2. **Test against real data.** Run `npm run dev -- today` and `npm run dev -- models` with your real sessions and confirm the output looks correct — costs are non-zero, model names resolve, session counts match what you see in the tool.
3. **Include proof in the PR.** Attach a screenshot or terminal output showing codeburn correctly parsing your real sessions. PRs for new providers without evidence of local testing will not be reviewed.
4. **Do not rely on AI-generated guesses about storage paths or schemas.** Tools change their data formats between versions. The only way to know the current schema is to install the tool and inspect the actual files on disk.
5. **Disclose your affiliation.** If you built the tool, work for the vendor, or otherwise benefit from it being listed, say so in the PR description. Being listed in CodeBurn is visibility in front of a large user base; undisclosed self-promotion gets the PR closed regardless of code quality. We may also hold new-tool submissions until the tool shows real adoption beyond its authors.

PRs that add a provider based solely on online documentation or AI-generated code, without evidence of testing against real data, will be closed.

## Pull Requests

1. Fork or branch from `main`.
2. Push your branch and open a PR against `main`.
3. The `firstlook` workflow will auto-assess the PR. The `semgrep` CI workflow runs the hot-path bracket-assign guard. The `block-claude-coauthor` workflow scans commits.
4. A maintainer reviews. For non-trivial changes, expect requests for tests.
5. Squash-merge is the default. Keep the PR title short and accurate; the description carries the context.

## Reporting Bugs

File issues at https://github.com/getagentseal/codeburn/issues. Useful details:

- Output of `codeburn --version`.
- Provider involved and rough size of your session history (`du -sh ~/.codex/sessions`, etc.).
- Output of the failing command with `DEBUG=1` if applicable.
- For parsing bugs: a redacted JSONL or SQLite snippet that reproduces the issue.

## Security Issues

Do not file security issues in the public tracker. See `SECURITY.md` for the disclosure process.

## License

CodeBurn is MIT-licensed. By contributing, you agree your contributions are licensed under the same terms.
