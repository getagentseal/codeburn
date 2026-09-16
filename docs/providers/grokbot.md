# Grok Bot

Grok Bot, xAI's Electron desktop agent app (bundle id `com.anysphere.sand`). Not Grok Build, xAI's coding CLI — that is the separate [`grok`](grok.md) provider.

Mapped against **app version 0.30.0**. The app self-updates, so the parser ignores unknown entry kinds and unknown fields rather than rejecting a file.

- **Source:** `src/providers/grokbot.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/grokbot.test.ts`

## Where it reads from

`$CODEBURN_GROKBOT_DIR`, else the app's Electron userData directory:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Grok Bot/sand-client-persistence` |
| Windows | `%APPDATA%\Grok Bot\sand-client-persistence` |
| Linux | `~/.config/Grok Bot/sand-client-persistence` |

**Not** `~/.grokbot`. That directory is the app's `$SAND_DATA_ROOT` (marked by `.grokbot-data-root-v1`) and holds the host process, the local exec daemon, settings, secrets and content-addressed runtime binaries. Its `agents/<uuid>/store.db` tables are empty on 0.30 and `search-index.db` has no rows: the authoritative agent store lives on the remote box at `/home/box/sand-data/agents/<id>/store.db`, and nothing in `~/.grokbot` carries usage.

## Storage format

JSON. Each file in `sand-client-persistence` is one client slice, named `base32(sliceKey).blob` (RFC 4648, lowercase, unpadded) and containing `{"schemaVersion":N,"value":…}`. Two slices matter:

- `sand.client.slice.account.<accountSlot>.roster.last-roster` — `value.rows[]`, one row per bot, with `id`, `name` ("Reddit Bot", "HN Reviewer"), avatar, unread state and `path`.
- `sand.client.slice.account.<accountSlot>.transcript.replicas.<agentId>` — `value.entries[]`, the transcript.

Transcript entry kinds: `message` (`role` `user`/`assistant`, `content`, optional `fromAgent`/`toAgent` for bot-to-bot), `send-message` (the bot's own output, `message.type` `text`/`widget`/`attachment`/`user-form`/…, optional `wake`), `event` (`event.type: "automation-changed"` with `automationName` — the Routines feature), `user-attachment`. Timestamps are `timestampMs`, ms since the epoch, UTC.

## Sessions and projects

Grok Bot has no projects and no session ids: work is organised as named bots, one per `agentId`, each with a chat thread, an attached browser screen and scheduled **Routines**. One transcript replica is one CodeBurn session, `sessionId` is the `agentId`, and the bot's roster `name` is used as both `project` and `agentName` so the report groups by bot. A bot missing from the roster falls back to its `agentId`.

One call is one `requestId` — the app stamps a prompt and every message the bot emits in reply with the same id.

**Routine runs are not human turns.** A `send-message` carries `wake` (`background-revival`, `handoff-resume`, `agent`) when the bot woke on its own, and a `message` carrying `fromAgent` came from another bot rather than from the person. A request with no bare user message is emitted with an empty `userMessage`, so the task classifier never reads a scheduled run as something someone asked for.

## Token model

**Estimated, always.** The local mirror records no token counts, no cost and no model id — a deep scan of every entry field finds no `usage`, `*Tokens`, `cost` or `model` anywhere, and the same holds for every other slice, for `search-index.db` and for every file under `~/.grokbot`. Input is estimated from the text of the `message` entries in a request (the person's prompt, plus anything another bot sent in), output from the `send-message` content, both through the repo's shared `CHARS_PER_TOKEN`. Cache-read, cache-creation and reasoning tokens are all zero; there is nothing to read them from. Every call sets `costIsEstimated: true`, and the provider is deliberately left out of the provider-name list in `providerCallToCachedCall` (`src/parser.ts:2571`) that carries a tool's own metered cost through the cache, so the cost is recomputed from the estimated tokens.

**The replica is a window, not an archive.** The app keeps roughly the last 200 entries per bot locally. A `lifetime` total covers what is still mirrored, not the bot's whole history.

**No tool calls and no bash commands.** The bots drive a browser and a sandbox shell, but no tool-call or command record reaches this machine — `tools` and `bashCommands` are always empty.

## Pricing

`grokbot-auto` is aliased to `grok-4.6` in `src/models.ts`, xAI's published rate of $2.00 / M input, $6.00 / M output and $0.50 / M cached input. The app serves opaque Cursor `sand-*` model aliases (`sand-78zum5`, `sand-cua`, …) and records none of them locally, so there is no honest per-model attribution to make; pricing it at xAI's current flagship rate, with the cost flagged estimated, is the closest truthful reading.

## Deduplication

Per `grokbot:<agentId>:<requestId>`.

## Quota

`codeburn quota`, the desktop app's Plans screen (`app/electron/quota/grokbot.ts`, a port of the reader below; the row is omitted when the app is not installed) and the macOS menubar's Grok Bot row (`mac/.../GrokBotSubscriptionService.swift`) all report Grok Bot's weekly allowance — the same "Weekly usage NN%, resets in N days" the app's own account menu shows, read from the call the app itself makes:

- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus`, Connect-RPC, empty JSON body, `Authorization: Bearer <cursor token>`. Response: `usagePercent` (0..100), `currentPeriodStart`, `nextResetTimestampUtc` (exactly seven days apart), `hasNonZeroIncludedLimit`, `usesPooledEnterpriseAllowance`, `hasAvailableUsage`, `upgradeRecommendation`, and `grokPlanLabel` on newer builds. Emitted as one window labelled `Weekly usage`.
- `GetCurrentPeriodUsage` on the same service returns `spendLimitUsage { individualUsed, individualLimit }` in cents, the "Change limit" surface. Not read: it is a spend cap, not a capacity window.

**No app, no row.** All three readers first check that the app is on the machine — `/Applications/Grok Bot.app`, `~/Applications/Grok Bot.app`, or the `~/.grokbot` data root — and leave the provider out entirely when it is absent. The reading would otherwise still succeed and report whichever account Cursor is signed into, under a Grok Bot label. An account that is signed in but has no per-account reading (a pooled enterprise allowance, or no included allowance) is reported as a terminal state carrying that sentence, not as "not connected".

**The credential is the Cursor IDE's, not Grok Bot's.** Grok Bot keeps its own copy of the Cursor session in `sand-secrets.json` as an Electron `safeStorage` blob (base64 of `v10` plus AES-128-CBC ciphertext, key in the macOS keychain), and CodeBurn does not decrypt an app's safe storage — the rule stated for "Codex Safe Storage" at `src/quota/codex.ts:109`. The Cursor IDE stores the same kind of token unencrypted in its VS Code state database under `cursorAuth/accessToken`, so `src/quota/grokbot.ts` reuses `src/quota/cursor.ts`'s read-only lookup of that row rather than duplicating it.

The consequence is a real precondition, not a detail: **this reading is Grok Bot's only when the Cursor app is signed into the account Grok Bot uses.** With Cursor signed out, the provider reports "not signed in", the same state `src/quota/cursor.ts` reports. With Cursor signed into a different account, the percentage is that other account's. Nothing local can verify the two match. `src/quota/cursor.ts` is not a substitute either: it reads `cursor.com/api/usage-summary` and reports that dashboard's monthly window, a different allowance on the same vendor's dashboard.

**Quota is the only usage number that exists.** The bots run on xAI's cloud VM; the prompts, the model and the token counts never leave it, so no per-request usage is obtainable by any method — not by reading disk, not by any endpoint. The weekly percentage is a capacity reading, not accounting, and it cannot be reconciled against the estimated token totals above.

## Live sessions

Not wired up yet. The signals are there: `sand-session-marker.json` (`pid`, `appVersion`, `startedAtMs`, `aliveAtMs`, `crashSeen`) in the userData directory, `~/.grokbot/local-exec-daemon.json` (`pid`, `inflightCount`), `~/.grokbot/host.lock`, and the roster row's `awaitingUserResponse` / `lastActivityAt`.

## Quirks

- **Two xAI products, two providers.** `grok` is the Grok Build CLI under `~/.grok`; `grokbot` is this desktop app. They share nothing but a vendor.
- **Bots message each other.** A `message` with `fromAgent` is another bot's output arriving here. It is counted as input, because the receiving bot had to read it, and it is not treated as a human turn.
- **`~/.grokbot/inference-router-transcript.json`** is written by a third-party reconstruction of app version 0.18, not by the shipped app. It is ignored.
