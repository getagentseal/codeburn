# Amp

Amp, Sourcegraph's coding agent ([ampcode.com](https://ampcode.com)), as a CLI or editor extension. Reported in #1572.

- **Source:** `src/providers/amp.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/amp.test.ts`

## Where it reads from

`$AMP_DATA_DIR/threads/` (or `~/.local/share/amp/threads/`). `AMP_DATA_DIR` is Amp's own override; CodeBurn accepts a comma-separated list the way Amp does. One JSON document per thread: `threads/<thread-id>.json`.

## Storage format

A thread file is `{ id, messages: [...], usageLedger?: { events: [...] } }`. `usageLedger.events` is the per-request record: `{ id, timestamp, model, tokens: { input, output, total }, toMessageId, credits }`. Cache tokens are not on the event - they live on the thread message the event billed for, joined through `toMessageId` -> `messages[].messageId` -> `usage.cacheCreationInputTokens` / `usage.cacheReadInputTokens`. Threads without a ledger fall back to per-assistant-message usage blocks (`{ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, totalTokens, timestamp, model }`, with `timestamp` and `model` allowed on the message itself). The format is mapped against ccusage's amp adapter, which parses real thread files.

## Token model

**Ledger-first.** When a thread carries a usage ledger, each event is one call. A total-only `tokens` record (`{"total": N}`) bills as `N` output tokens. Cache tokens come from the billed message via `toMessageId`; a record whose `toMessageId` does not resolve prices without cache. No reasoning field exists, so `reasoningTokens` is 0.

**Fallback.** Without a ledger, every assistant message with a usable usage block is one call.

A record with all four token fields empty or malformed contributes nothing; untrusted numbers are clamped to finite non-negative before they can reach the aggregate.

## Pricing

Amp bills a subscription, not tokens, and records no charged dollars, so every call is priced from the model's token rates in `src/models.ts` and carries `costIsEstimated`. Amp's model ids are the underlying OpenAI/Anthropic/Google ids and price through the standard catalog. The recorded `credits` field is ignored: Amp publishes no per-credit dollar rate to convert it with.

## Caching

Cache-read and cache-creation counts arrive through the ledger join (or the message's usage block). Token-priced costs are not cached; the cached call is re-priced on read, so a pricing update reaches history.

## Deduplication

Per `amp:<thread-id>:<event-id>` from the ledger, or `amp:<thread-id>:<timestamp>:<model>` on the message fallback path.

## Quirks

- **No project attribution.** Thread files carry no cwd, so Amp sessions group under the provider name (`Amp`) instead of a repository.
- **No tool capture.** Thread files expose no tool-call records CodeBurn could read, so `tools` and `bashCommands` are empty.
- **Estimated costs by design.** Every call is marked `costIsEstimated` (see Pricing). Token counts themselves are provider-recorded.
- **`credits` is display data.** Amp's internal credit ledger has no published dollar conversion; it is not summed into cost.

## When fixing a bug here

1. Discovery: check the `threads/*.json` walk, the `.json` extension filter, and the `AMP_DATA_DIR` resolution (comma-separated).
2. Token accounting: see `parseThreadFile` (ledger join through `toMessageId` -> `messages[].messageId`, then the per-message fallback).
3. Add a fixture-format thread under `tests/providers/amp.test.ts`; do not mock the filesystem.
