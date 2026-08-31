# Gemini

Google Gemini CLI.

- **Source:** `src/providers/gemini.ts`
- **Loading:** eager (`src/providers/index.ts:5`)
- **Test:** `tests/providers/gemini.test.ts`

## Where it reads from

`~/.gemini/tmp/<project>/chats/session-*.json` and `session-*.jsonl` (`gemini.ts:218-252`).

## Storage format

Either a single JSON document per session or JSONL, depending on Gemini CLI version. The parser sniffs the first non-whitespace character to decide (`gemini.ts:197-206`).

## Caching

None.

## Deduplication

Per `sessionId` (`gemini.ts:72`). Gemini sessions are aggregated to a single call per session.

## Quirks

- **Cached tokens are a subset of input.** Gemini reports cached tokens included inside `promptTokenCount`. The parser subtracts them so callers see Anthropic semantics (cached are separate).
- **Thoughts are billed at output rate** (`gemini.ts:125`).
- Each session collapses to one `ParsedProviderCall`. If you need per-turn data, the upstream format does not support it without re-parsing the prompt history.

## When fixing a bug here

1. Add a fixture and a focused case to `tests/providers/gemini.test.ts` before changing parsing logic.
2. If the bug involves a new Gemini version's schema, sniff with the same first-character heuristic; do not call `JSON.parse` on the whole file.
3. If the bug is "Gemini sessions report less than expected", check whether the cached-token subtraction is over-correcting.
