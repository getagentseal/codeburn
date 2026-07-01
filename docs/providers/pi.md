# Pi

Pi agent CLI.

- **Source:** `src/providers/pi.ts`
- **Loading:** eager (`src/providers/index.ts:9`)
- **Test:** `tests/providers/pi.test.ts` (336 lines)

## Where it reads from

`~/.pi/agent/sessions/` (`pi.ts:55-57`).

## Storage format

JSONL (`pi.ts:98`).

## Caching

None.

## Deduplication

Per `<provider>:<path>:<responseId>` when a response ID is present, falling back to the entry timestamp, and finally to a line index (`pi.ts:164`).

## Quirks

- Undefined token fields in `message.usage` are coerced to `0` (`pi.ts:156-159`); never `undefined`.
- The provider name is taken from `source.provider` (`pi.ts:182`), not hard-coded. This matters because `pi.ts` is the parser for **both** Pi and OMP; see [`omp.md`](omp.md).
- Tool-call content type is extracted from the message envelope (`pi.ts:169-176`).
- Pi/OMP have no dedicated skill tool: a native skill load is a `read` whose path points at a skill's `SKILL.md` (or a `skill://<name>` URI in newer OMP builds). The parser surfaces these as the `Skill` tool and records the name in `skills` (mirroring the Claude parser) instead of counting a `Read`, so the shared classifier tags the turn `general` and the Skills & Agents breakdown picks it up (`skillLoadName`, issue #588).

## When fixing a bug here

1. If you change parsing logic, also run `tests/providers/omp.test.ts` because OMP shares this code.
2. If the bug is "tokens are NaN", look at the coercion at `pi.ts:156-159`. A regression on this is silent and easy to miss.
3. If the bug is specific to the dedup behavior, decide which of the three fallback keys was used by adding a temporary log; the keys collide differently for old vs. new Pi versions.
