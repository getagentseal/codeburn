# vscode-cline-parser (Shared Helper)

Shared discovery and parsing for Cline and VS Code extensions descended from Cline.

- **Source:** `src/providers/vscode-cline-parser.ts`
- **Loading:** not a provider; imported by `cline.ts`, `ibm-bob.ts`, and `kilo-code.ts`.
- **Test:** none directly. Coverage comes from `tests/providers/cline.test.ts`, `tests/providers/ibm-bob.test.ts`, and `tests/providers/kilo-code.test.ts`.

## What it does

Two responsibilities:

1. `discoverClineTasks(extensionId)` walks a base directory's `tasks/` child and returns one source per task that has a `ui_messages.json` file (`vscode-cline-parser.ts:25-50`). Without an override directory it uses VS Code's `globalStorage/<extensionId>/` path.
2. `discoverClineTasksInBaseDirs(baseDirs)` does the same for non-VS Code apps with compatible task storage, such as IBM Bob.
3. `createClineParser` reads each task's `ui_messages.json` and `api_conversation_history.json`, extracts model, tools, and token counts, and yields `ParsedProviderCall` objects.

## Storage layout

Per task directory:

```
<baseDir>/tasks/<taskId>/
  ui_messages.json                # event stream
  api_conversation_history.json   # full prompt history with model tags
```

## Model resolution

The model is extracted from `api_conversation_history.json` by searching user message content blocks for a `<model>...</model>` tag. Falls back to the provider-supplied auto model (`cline-auto` by default) if no tag is found.

## Token extraction

From `api_req_started` entries inside `ui_messages.json`. Each such entry's `text` field is JSON-parsed; the parsed object holds `tokensIn`, `tokensOut`, `cacheReads`, `cacheWrites`, and (optionally) `cost`.

If `cost` is present, it is used directly. If not, `calculateCost` from `src/models.ts` computes it from tokens.

## Deduplication

Per `<providerName>:<taskId>:<index>` where `index` is the position of the `api_req_started` entry within `ui_messages.json`.

## Quirks

- Only the **first** user message is emitted as `userMessage` in the `ParsedProviderCall`. Subsequent user turns are accounted but not surfaced.
- The model regex looks inside content blocks, not at top-level fields. Some Cline-derivative extensions emit the model elsewhere; if you add support for one, branch on extension ID rather than rewriting the regex.

## When fixing a bug here

1. A change here ripples to Cline, IBM Bob, and KiloCode. Run all three provider test files before opening a PR.
2. If you find that one of the extensions emits a different shape, branch on the extension ID parameter that the discovery function already takes; do not duplicate the parser.
3. If you add support for another Cline-family task store, register it as a thin wrapper file in the same shape as `cline.ts`, `ibm-bob.ts`, and `kilo-code.ts`.
