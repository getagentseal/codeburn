# KiloCode

KiloCode VS Code extension.

- **Source:** `src/providers/kilo-code.ts`
- **Loading:** eager (`src/providers/index.ts:6`)
- **Test:** `tests/providers/kilo-code.test.ts` (62 lines)

## Where it reads from

VS Code extension globalStorage for `kilocode.kilo-code` (extension ID set at `kilo-code.ts:4`). The actual walk is delegated to `discoverClineTasks` in `src/providers/vscode-cline-parser.ts`.

## Storage format

Per-task directories with `ui_messages.json` and `api_conversation_history.json`. See [`vscode-cline-parser`](vscode-cline-parser.md) for the full schema description.

## Caching

None at the provider level; delegates to the shared helper.

## Deduplication

Delegated. Per `<providerName>:<taskId>:<index>` (handled in `vscode-cline-parser.ts:109`).

## Quirks

- This file is a thin wrapper. Almost every bug for KiloCode actually lives in `vscode-cline-parser.ts`.
- The VS Code extension wrappers using the Cline-family parser differ **only** by extension ID.

## When fixing a bug here

1. If the bug is "Cline and KiloCode both broken in the same way", fix it in `vscode-cline-parser.ts`.
2. If the bug is "KiloCode broken, Cline fine", the difference is upstream (KiloCode's emitted JSON differs slightly). Reproduce with a fixture and consider whether the cline parser needs to branch on extension ID.
3. Read [`vscode-cline-parser.md`](vscode-cline-parser.md) before editing.
