# Open Design

Open Design agent runs and per-model token usage.

- **Source:** `src/providers/open-design.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/open-design.test.ts`

## Where it reads from

`$CODEBURN_OPEN_DESIGN_DIR` when set. Otherwise CodeBurn uses the platform application-data directory:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Open Design` |
| Windows | `%APPDATA%/Open Design` |
| Linux | `~/.config/Open Design` |

Discovery accepts a `runs/` or `data/` directory directly and also scans `namespaces/<namespace>/data/runs/`. Each run is represented by `<run-id>/events.jsonl`.

## Storage format

`events.jsonl` contains start, status, and usage events. Start and status events select the active model. Agent usage events provide input, output, cache-read, and reasoning-token counts. Malformed and unrelated lines are skipped independently.

## Caching

No provider-specific cache. The shared session cache applies to parsed sources.

## Deduplication

Per run and event id: `open-design:<run-id>:<event-id>`. Entries without an id receive a stable line-order fallback within the parse.

## Quirks

- Usage is emitted only after a model has been observed from a start or status event.
- Cached reads are included in `input_tokens`; CodeBurn subtracts them before pricing fresh input.
- Reasoning tokens are reported separately and priced at the output rate.
- Open Design records no tools or shell-command detail in this event shape.

## When fixing a bug here

1. Add a sanitized run under `tests/fixtures/open-design/` and a focused case in `tests/providers/open-design.test.ts`.
2. Preserve mixed-model runs: each usage event must use the model active at that point in the stream.
3. Test direct data directories and namespaced layouts when changing discovery.
