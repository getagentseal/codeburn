# Export

`codeburn export` writes your usage to files that a spreadsheet or a program can read. It writes either one JSON file or a folder of CSV files.

```bash
codeburn export                                  # a folder of CSV files, named codeburn-YYYY-MM-DD
codeburn export -f json                          # one file, codeburn-YYYY-MM-DD.json
codeburn export -f json --from 2026-04-01 --to 2026-04-30 -o april.json
```

## Options

| Option | Meaning |
|---|---|
| `-f, --format <format>` | `csv` (default) or `json` |
| `-o, --output <path>` | Where to write. See Output names below |
| `--from <date>`, `--to <date>` | A custom range, as local dates (`YYYY-MM-DD`). Both days are included in full. The export then holds one period instead of three. Without `--from`, the range starts 6 months back. Without `--to`, it ends today |
| `--provider <provider>` | Only one tool, for example `claude` or `codex`. Default `all` |
| `--route <route>` | Only one billing route: `direct`, `bedrock`, `openrouter` or `vertex` (`direct` includes unknown) |
| `--billing <mode>` | `metered` or `subscription` |
| `--project <name>` | Only projects matching the name. Repeat the flag for more than one |
| `--exclude <name>` | Leave out projects matching the name. Repeat the flag for more than one |

## Output names

JSON:

- `-o report.json` writes that file. `-o report` writes `report.json`.
- `-o some/folder/` (a trailing slash) or `-o` an existing folder writes `codeburn-export-YYYY-MM-DD.json` inside it.
- With no `-o`, the file is `codeburn-YYYY-MM-DD.json` in the current folder.
- If the target file exists, CodeBurn overwrites it only when its first 4 KB contain the `"schema": "codeburn.export.v` line. Any other file is refused, and so is an existing folder.

CSV:

- The output is a folder. `-o out.csv` writes the folder `out`. With no `-o`, the folder is `codeburn-YYYY-MM-DD`.
- If `-o` is an existing folder that CodeBurn did not create, the files go in a new `codeburn-export-YYYY-MM-DD` folder inside it.
- Every folder CodeBurn creates holds an empty `.codeburn-export` marker file. A folder with the marker is emptied and rewritten on the next export. A folder without it, and any existing file, is refused.
- If there is no usage at all, no CSV files are written and the command says `No usage data found.` The JSON export still writes a valid file with empty lists.

## Which periods the export holds

Without `--from` and `--to`, the export has three periods, labeled `Today`, `7 Days` and `30 Days`. They are measured in local days of the machine:

| Label | Covers |
|---|---|
| `Today` | Since local midnight |
| `7 Days` | From local midnight 7 days ago until now (8 calendar days) |
| `30 Days` | From local midnight 30 days ago until now (31 calendar days) |

With `--from` or `--to`, there is one period. Its label is `<from> to <to>`, for example `2026-04-01 to 2026-04-30`. If you leave one side out, the label says `all` for a missing `--from` and `today` for a missing `--to`.

Only some sections follow every period. The others cover one period only:

| Section | Period it covers |
|---|---|
| `summary` | Every period |
| `periods` (`daily`, `activity`, `models`) | Every period, one entry per period |
| `projects`, `sessions`, `records`, `tools`, `mcp`, `shellCommands` | The `30 Days` period. With a custom range, the one period of that range |

So a default export has `Today` and `7 Days` totals in `summary` and `periods`, but the `records` list holds the last 30 days. Do not add up `records` and expect the `Today` total.

## JSON

The top-level keys, in this order:

| Key | Type | Meaning |
|---|---|---|
| `schema` | string | The format version. Currently `codeburn.export.v3` |
| `generated` | string | When the file was written, ISO 8601, UTC |
| `currency` | object | `code` (for example `USD`), `rate` (number, units of `code` per 1 USD) and `symbol` |
| `summary` | list | One row per period |
| `periods` | list | One object per period: `label`, `daily`, `activity`, `models` |
| `projects` | list | One row per project |
| `sessions` | list | One row per session |
| `records` | list | One row per served API call |
| `tools` | list | Tool calls |
| `mcp` | list | MCP server calls |
| `shellCommands` | list | Shell commands run by the agent |

Units used in every table below:

- Tokens are integers.
- Money is a number in the currency in `currency.code`. There is no unit in the key. Money in every section except `records` is rounded to the currency's usual decimals (2 for USD, 0 for JPY). Money in `records` is not rounded.
- `share` is a percent from 0 to 100, with 2 decimals.
- `costBasis` in a record is a text value. In `daily` and `sessions` it is an object that gives the share of cost, as a fraction from 0 to 1, for each of `recorded`, `calculated` and `estimated`. A share of zero is left out.
- A cell with no value is an empty string `""` where the table says so. Fields marked optional are left out of the object when they have no value.

### `summary`

| Field | Type | Meaning |
|---|---|---|
| `period` | string | Period label |
| `cost` | number | Cost |
| `saved` | number | What local calls would have cost at a paid model's price. Their `cost` is 0 |
| `apiCalls` | number | Number of API calls |
| `sessions` | number | Number of sessions |
| `projects` | number | Number of projects with cost or savings |

### `periods[].daily`

One row per local day with usage.

| Field | Type | Meaning |
|---|---|---|
| `period` | string | Period label |
| `date` | string | Local calendar day, `YYYY-MM-DD` |
| `cost` | number | Cost |
| `saved` | number | Savings |
| `apiCalls` | number | API calls |
| `sessions` | number | Sessions with a call that day |
| `inputTokens` | number | Input tokens |
| `outputTokens` | number | Output tokens |
| `cacheReadTokens` | number | Tokens read from the cache |
| `cacheWriteTokens` | number | Tokens written to the cache |
| `costBasis` | object | Share of cost by basis. Optional |

### `periods[].activity`

Spend by kind of work, biggest first.

| Field | Type | Meaning |
|---|---|---|
| `period` | string | Period label |
| `activity` | string | Category name. One of `Coding`, `Debugging`, `Feature Dev`, `Refactoring`, `Testing`, `Exploration`, `Planning`, `Delegation`, `Git Ops`, `Build/Deploy`, `Conversation`, `Brainstorming`, `General` |
| `cost` | number | Cost |
| `share` | number | Percent of the period's cost |
| `turns` | number | Number of turns |

### `periods[].models`

Spend by model, biggest first. The model name here is the short display name, for example `Sonnet 4.5`. Records and sessions use the raw model id.

| Field | Type | Meaning |
|---|---|---|
| `period` | string | Period label |
| `model` | string | Model display name |
| `cost` | number | Cost |
| `saved` | number | Savings |
| `share` | number | Percent of the period's cost |
| `apiCalls` | number | API calls |
| `editTurns` | number | Turns that edited files |
| `oneShotRate` | number or `""` | Percent of edit turns done without a retry. Empty when there are no edit turns |
| `retriesPerEdit` | number or `""` | Average retries per edit turn. Empty when there are no edit turns |
| `costPerEdit` | number or `""` | Cost per edit turn. Empty when there are no edit turns |
| `inputTokens` | number | Input tokens |
| `outputTokens` | number | Output tokens |
| `cacheReadTokens` | number | Cache read tokens |
| `cacheWriteTokens` | number | Cache write tokens |

### `projects`

Biggest first.

| Field | Type | Meaning |
|---|---|---|
| `project` | string | Project folder, as CodeBurn names it |
| `cost` | number | Cost |
| `saved` | number | Savings |
| `avgPerSession` | number or `""` | Cost divided by sessions |
| `share` | number | Percent of the cost of all projects |
| `apiCalls` | number | API calls |
| `sessions` | number | Sessions |

### `sessions`

Biggest first.

| Field | Type | Meaning |
|---|---|---|
| `project` | string | Project folder |
| `sessionId` | string | Session id from the tool |
| `startedAt` | string | Time of the first event, ISO 8601, as the tool wrote it (UTC for Claude Code). `""` when unknown |
| `cost` | number | Cost |
| `saved` | number | Savings |
| `apiCalls` | number | API calls |
| `turns` | number | Number of turns |
| `subagentType` | string | Subagent type. Optional |
| `model` | string | Raw model id. Only when the session used exactly one model. Optional |
| `costBasis` | object | Share of cost by basis. Optional |
| `retained` | boolean | `true` when the session was kept from the cache after the tool removed its transcript. Optional |
| `identity` | string | Organization or account name that was active when the session started. Only once CodeBurn has seen two or more Claude identities. Optional |

### `records`

The raw ledger: one row per served API call, in the order read. Some rows are accounting-only (see `supplementary`).

| Field | Type | Meaning |
|---|---|---|
| `project` | string | Project folder |
| `sessionId` | string | Session id |
| `timestamp` | string | Time of the call, ISO 8601, as the tool wrote it (UTC for Claude Code). Optional |
| `category` | string | Turn category as a lowercase id: `coding`, `debugging`, `feature`, `refactoring`, `testing`, `exploration`, `planning`, `delegation`, `git`, `build/deploy`, `conversation`, `brainstorming`, `general` |
| `provider` | string | Tool id, for example `claude`, `codex`, `cursor`. Run `codeburn export --provider x` to print the full list |
| `subagentType` | string | Subagent type. Optional |
| `model` | string | Raw model id. Optional |
| `inputTokens` | number | Input tokens |
| `outputTokens` | number | Output tokens |
| `reasoningTokens` | number | Reasoning tokens |
| `cacheWriteTokens` | number | Cache write tokens |
| `cacheReadTokens` | number | Cache read tokens |
| `cost` | number | Cost, not rounded |
| `savings` | number | Savings, not rounded |
| `costBasis` | string | Where the cost came from: `recorded` (the tool's own figure), `calculated` (measured tokens at published prices), `estimated` (guessed tokens), `included` (covered by a subscription, $0) or `unpriced` (no known price, $0). Optional |
| `supplementary` | boolean | `true` for an accounting-only row: recovered tokens or cost that is not a separate request. Optional |
| `estimated` | boolean | `true` when the cost was priced from estimated or missing token counts. Optional |
| `unpriced` | boolean | `true` for a `$0` row whose model has no known price. Optional |
| `retained` | boolean | `true` when the session was kept after its transcript was removed. Optional |
| `listCost` | number | Cost at list price, before your price discount. Only when a price discount is set. Optional |
| `identity` | string | Same as in `sessions`. Optional |

To count requests, skip rows where `supplementary` is `true`.

### `tools`, `mcp`, `shellCommands`

Biggest first. They share one shape, with a different first field.

| Section | First field | Meaning |
|---|---|---|
| `tools` | `tool` | Tool name, for example `Bash`, `Edit`, `Read` |
| `mcp` | `server` | MCP server name |
| `shellCommands` | `command` | The name of each command the agent ran, for example `git` |

| Field | Type | Meaning |
|---|---|---|
| `calls` | number | Number of calls |
| `share` | number | Percent of all calls in this section |

## CSV

The CSV folder holds one table per file. All files are UTF-8 with a header row.

| File | Same data as |
|---|---|
| `summary.csv` | `summary` |
| `daily.csv` | `periods[].daily`, all periods in one table |
| `activity.csv` | `periods[].activity`, all periods in one table |
| `models.csv` | `periods[].models`, all periods in one table |
| `records.csv` | `records` |
| `projects.csv` | `projects` |
| `sessions.csv` | `sessions` |
| `tools.csv` | `tools` |
| `mcp.csv` | `mcp` |
| `shell-commands.csv` | `shellCommands` |
| `README.txt` | A short description of the files, the currency and the periods |
| `.codeburn-export` | An empty marker file. See Output names |

Differences from JSON:

- Most headers are words, for example `API Calls`, `Share (%)` and `Cost (USD)`. The currency code in the money headers follows your currency setting. `records.csv` and the last columns of `sessions.csv` (`subagentType`, `model`, `retained`) use the JSON key names instead. Read columns by header name.
- `daily.csv` and `sessions.csv` have no `costBasis` column. `records.csv` does.
- A column is written when the first row has the key. The optional `records.csv` columns `supplementary`, `estimated`, `unpriced` and `retained` are always there, empty when false. `listCost` and `identity` appear only in the cases given above.
- A text value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a `'` in front, so a spreadsheet does not run it as a formula.
- Numbers have at most 8 decimals and never use an exponent.

## Currency

Every money value is already converted to the currency you set with `codeburn currency`. The JSON states it once in `currency.code`, with the `rate` that was used. The default is USD, with a rate of 1.

## Size

Long histories make big files. A JSON export or `records.csv` can reach hundreds of MB. Read them with a streaming parser, and do not load the whole file into one string.

## Privacy

The export holds counts, costs, timestamps, model names, project names, session ids, and tool, MCP server and shell command names. It never holds prompts, replies, code or file contents. It is written to your disk only. Check it before you share it, because project names and session ids can say what you work on.

## Format versions

Every JSON export starts with a `schema` field. It changes when a field is removed, renamed, or changes meaning. Read `schema` first, and ignore fields you do not know.

- `codeburn.export.v2` added the `currency` object.
- `codeburn.export.v3` gave every row fixed camelCase keys, for example `apiCalls` and `cost`. Version 2 used the CSV headers as keys, such as `API Calls` and `Cost (USD)`, and the money key changed with your currency. The currency is now stated once, in `currency.code`. The CSV headers did not change.

New fields can appear under the same `schema` value.
