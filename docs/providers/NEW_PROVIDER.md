# New provider checklist

Guide for adding a new session-discovery provider to codeburn. Follow every item; most exist because a past provider broke without them.

## One provider, one product

- [ ] A provider is one product. Same-vendor IDE and CLI products get separate providers.
- [ ] Precedents: `kimi` / `kimicode`, `cursor` / `cursor-agent`, `cline` / `cline-cli`.
- [ ] Do not merge products under one provider name. `PROVIDER_PARSE_VERSIONS` and `PROVIDER_ENV_VARS` are keyed by provider name, so merging couples cache invalidation across products.
- [ ] Separate providers also keep `codeburn doctor` output legible.

## Required pieces

- [ ] `src/providers/<name>.ts` implementing the Provider contract.
- [ ] Registration in `src/providers/index.ts` `coreProviders` (or the lazy list).
- [ ] `PROVIDER_ENV_VARS` entry in `src/session-cache.ts` when discovery reads env overrides.
- [ ] `PROVIDER_PARSE_VERSIONS` entry when cached entries must re-parse after parser changes.
- [ ] `probeRoots()` is required for new providers, not optional. `codeburn doctor` uses it to tell "not installed" from "override points somewhere empty" - the silent-$0.00 class (#874, #899).

## Cost rules

- [ ] If the tool meters its own per-message cost, add the provider to the reported-cost allowlist in `src/parser.ts` (`providerCallToCachedCall`).
- [ ] Cost presence is a PRESENCE check, not truthiness: a metered $0 stays reported (free/cached calls).
- [ ] Computed costs go through `calculateCost` and set `costIsEstimated: true`.

## Parsing rules

- [ ] Defensive reads on every field - records may be any JSON.
- [ ] Dedup keys namespaced as `<provider>:<sessionId>:<messageId>`.
- [ ] Timestamps guard against seconds-vs-milliseconds: promote and reject implausible values (see `kiro.ts` / `cline-cli.ts`).
- [ ] Never let one corrupt file throw - skip it.

## Tests

- [ ] Fixture-based tests under `tests/providers/<name>.test.ts` covering discovery, parsing, cost semantics, and `probeRoots` resolution.
- [ ] The suite scrubs env in `tests/setup/env-isolation.ts`, so tests set their own overrides.

## PR expectations

- [ ] Proof of real local testing in the PR body: generated sessions from the actual tool, not only fixtures.
- [ ] No Claude/Anthropic co-author trailers - CI rejects them.
- [ ] Docs page under `docs/providers/<name>.md` describing the storage layout and any quirks.

## Fastest path

Read `src/providers/cline-cli.ts` end to end first. It is the most recent provider and demonstrates every rule above.
