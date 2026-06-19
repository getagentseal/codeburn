# Zerostack

Zerostack (gi-dellav/zerostack) — a minimal Rust coding agent inspired by Pi and OpenCode. Supports OpenRouter (default), OpenAI-compatible, Anthropic, Gemini, Ollama, and custom providers.

- **Source:** `src/providers/zerostack.ts`
- **Loading:** core (`src/providers/index.ts`)
- **Test:** _none yet — see status below._

## Where it reads from

`$XDG_DATA_HOME/zerostack/sessions/` (falls back to `~/.local/share/zerostack/sessions/`). Discovery handles both flat session files and one-directory-per-project layouts.

## Storage format

Plain-text per-session files. The parser currently assumes JSONL with Pi-style `session` / `message` entries.

## Caching

None.

## Deduplication

Per `<provider>:<path>:<responseId|id|timestamp|lineIndex>`.

## Status: UNVERIFIED — do not open a PR yet

This provider was scaffolded from zerostack's public docs and modeled on `pi.ts`. The on-disk schema (field names, entry types, whether sessions are JSONL at all) has **not** been confirmed against real data.

Per `CONTRIBUTING.md` ("Adding a New Provider"), before this can ship:

1. Install zerostack and generate real sessions by actually coding with it.
2. Inspect the files under `$XDG_DATA_HOME/zerostack/sessions/` and correct `ZerostackEntry` + the parser to match the real format.
3. Run `npm run dev -- today` / `npm run dev -- models --provider zerostack` and confirm costs are non-zero and models resolve.
4. Add a fixture-based `tests/providers/zerostack.test.ts`.
5. Comment on the relevant issue first and attach proof (screenshot / terminal output) to the PR.
