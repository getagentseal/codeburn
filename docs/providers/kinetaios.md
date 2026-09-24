# KinetAios

KinetAios, a local-first AI agent desktop app (Electron, multi-engine).

- **Source:** `src/providers/kinetaios.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/kinetaios.test.ts`

## Where it reads from

The app's own `history.db` (SQLite, WAL mode) inside its Electron userData
directory. KinetAios pins that directory name to `KinetAios` regardless of
productName, so the default path is stable:

- macOS: `~/Library/Application Support/KinetAios/history.db`
- Windows: `%APPDATA%/KinetAios/history.db`
- Linux: `$XDG_CONFIG_HOME/KinetAios/history.db` (default `~/.config/KinetAios`)

`CODEBURN_KINETAIOS_DB` overrides the db path (registered in
`PROVIDER_ENV_VARS` so a swap forces the one re-parse).

## Storage format

Two tables matter:

- `cost_log` — one row per completed LLM turn: `id` (TEXT uuid, primary key),
  `conv_id`, `engine`, `amount` (REAL USD, priced by the app from its own
  per-profile rate table), `tokens`, `ts` (ms), `tokens_in`, `tokens_out`
  (added in v3.7+; older rows carry the whole-turn total in `tokens` with both
  splits at 0).
- `conversations` — `model` and `cwd` live here, not in `cost_log`, so the
  parser LEFT JOINs on `conv_id`. Conversation rows can be deleted
  independently; a missed join falls back to `kinetaios-auto` / a db-qualified
  project name.

## Session model

The db is one session (`<dbPath>:kinetaios`); each `cost_log` row becomes one
call. Dedup key is `<provider>:<db>:<row id>` — append-only rows with a
primary-key id make rescans idempotent.

## Cost

`amount` is what the turn actually cost (billing-derived, preserved through
the cache via `costFromBilling`). Absent or `<= 0` falls back to the bundled
pricing table and stays re-priceable. Legacy whole-total rows attribute the
total to input: each KinetAios turn resends its growing transcript, so the
input side dominates.

## Quirks

- `tokens_in`/`tokens_out` did not exist before v3.7 — never assume the
  columns are populated.
- `conversations.model` is per-conversation, not per-call: a conversation that
  switched models mid-way reports the switch under its latest model. This is
  what the app itself bills on, so the parser does not second-guess it.
