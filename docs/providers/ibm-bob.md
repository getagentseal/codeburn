# IBM Bob

IBM Bob IDE task history.

- **Source:** `src/providers/ibm-bob.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/ibm-bob.test.ts`

## Where It Reads From

IBM Bob stores IDE task history below `User/globalStorage/ibm.bob-code/tasks/` in the application data directory.

Default paths checked:

| Platform | Paths |
|---|---|
| macOS | `~/Library/Application Support/IBM Bob/User/globalStorage/ibm.bob-code/`, `~/Library/Application Support/Bob-IDE/User/globalStorage/ibm.bob-code/` |
| Windows | `%APPDATA%/IBM Bob/User/globalStorage/ibm.bob-code/`, `%APPDATA%/Bob-IDE/User/globalStorage/ibm.bob-code/` |
| Linux | `$XDG_CONFIG_HOME/IBM Bob/User/globalStorage/ibm.bob-code/`, `$XDG_CONFIG_HOME/Bob-IDE/User/globalStorage/ibm.bob-code/` with `~/.config` fallback |

The `Bob-IDE` paths cover the preview-era app name that some installs used before the GA `IBM Bob` directory.

## Storage Format

Each task is a directory under `tasks/<task-id>/` and must contain `ui_messages.json`.

CodeBurn parses the same Cline-family UI event format used by Cline and KiloCode:

- `ui_messages.json` entries with `type: "say"` and `say: "api_req_started"` contain serialized token/cost metrics.
- `ui_messages.json` user text entries seed the turn's first user message.
- `api_conversation_history.json` is optional and is used to extract the selected model from `<model>...</model>` environment details when present.
- `task_metadata.json` may exist upstream, but CodeBurn does not need it for usage math today.

If no model tag is present, the parser uses `ibm-bob-auto`, which is priced through the same conservative Sonnet fallback used for Cline-family auto modes.

## Caching

None at the provider level.

## Deduplication

Per `<providerName>:<taskId>:<apiRequestIndex>` via `vscode-cline-parser.ts`.

## Quirks

- IBM Bob has shipped under both `IBM Bob` and `Bob-IDE` application data folder names.
- This provider intentionally covers the IDE task-history format. Bob Shell's `~/.bob` checkpoint data is a separate storage surface and is not parsed until we have a stable usage schema fixture.
- The shared Cline parser does not currently extract individual tool names from UI messages, so tool breakdowns are empty for IBM Bob just like Cline and KiloCode.

## When Fixing A Bug Here

1. Check whether the install uses `IBM Bob` or `Bob-IDE` as the application data directory.
2. Confirm the task folder still contains `ui_messages.json` and `api_conversation_history.json`.
3. If the UI message schema changed, add a focused fixture to `tests/providers/ibm-bob.test.ts`.
4. If the change also affects Cline or KiloCode, update `src/providers/vscode-cline-parser.ts` and run all three provider test files.
