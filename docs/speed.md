# Generation speed by model and harness

`codeburn speed` reports local timing samples grouped by **harness, actual model
ID, source and timing resolution**. A model used in Claude Code and Hermes has
separate rows. The speed report does not rewrite model IDs to pricing aliases.
For Antigravity CLI capture, the model is the ID supplied by `init.model`;
its result frame does not expose a separate served-model ID.
It does not change spend accounting or send telemetry to a cloud service.

```sh
codeburn speed
codeburn speed --harness zcode --since 2026-10-01 --json
codeburn speed --no-history --file /path/to/speed.jsonl
codeburn speed events REQUEST_ID --file /path/to/speed.jsonl
```

The default file is `$CODEBURN_CACHE_DIR/speed.jsonl` (otherwise
`~/.cache/codeburn/speed.jsonl`), overridable with `CODEBURN_SPEED_FILE` or
`--file`. Files use `0600` on POSIX; on Windows the user's directory ACL applies.
Collection is opt-in: neither `speed` nor
the ordinary dashboard changes a harness configuration or starts a proxy.
Telemetry is separate from the existing consent-gated `sync` feature and is
not included in its exports.

Reports read a recent window bounded by `--limit` (default 10,000) and a 64 MiB
token-event memory estimate. Harness/date filters apply before that window.
Omitted records are disclosed in text/JSON; full timelines remain on disk.
`speed events` filters by request identity while reading, so an older trace can
be inspected without retaining every intervening token event.

## Desktop, menubar and Capacity Dock

[UI screenshots and fixture provenance](images/speed/README.md) show the desktop
table, arrival inspector, menubar summary and Capacity Dock block.

Open **Speed** in the desktop sidebar (Command/Ctrl+0). The table separates model,
harness, source and precision, with **generation tok/s**, first-arrival latency,
request duration and generation-timed/observed counts. Select a harness or date window in
the toolbar. Stored captures have an **Inspect** action showing reported output
tokens separately from recorded arrivals, plus a bounded arrival graph. History
estimates have no persisted per-request timeline to inspect. **Generation tok/s
excludes the wait for the first token** on every surface. The displayed value is
the median of eligible per-request rates. First-arrival latency is separate.
An end-to-end request average is retained only in JSON for diagnostics; it never
substitutes for unavailable generation speed. Chunk and request rates always
carry `~`, and need at least one second of streaming after the first arrival:
two closely spaced, buffered chunks measure delivery, not decode speed.

Speed has its own explicit scope: **this device, all projects and accounts**.
Timing records do not carry project, account or synced-device attribution. The
usual project/account filters therefore do not apply to this screen. Missing
samples and incomplete requests are not displayed as zero speed. Capture is still
opt-in; use **Capture setup** to configure a supported timing source.

The macOS menubar popover shows the six most recently observed model/harness/source
groups in the last 24 hours. A Capacity Dock provider's detail popover shows its
most recent timed model group when that provider has a matching speed record
(current dock catalog: Codex, Claude, ZCode and Antigravity). These are median
generation rates over the window, excluding the initial wait. Precision and local,
all-account/project scope are shown alongside the value. Speed can be shown even
when no quota snapshot is available. Failed refreshes retain a visibly stale
snapshot; speed fetching is independent of usage/plan refreshes.

Desktop polling has a 60-second minimum interval and respects slower/manual
refresh settings. Native background reads also have a 60-second minimum between attempts,
share one in-flight request and follow the existing refresh lifecycle. Explicit
manual refresh can request a fresh snapshot. Both GUI
surfaces read up to 100,000 ZCode requests inside the window (and the seven days
before it, for the typical day) and pass `--no-turn-estimates` to skip Codex log
discovery entirely, because turn-only history cannot measure generation speed.
A 30-day read of about 64,000 real ZCode requests took 0.9 s; the menubar's
24-hour window plus its typical week took 0.6 s. Collected records retain the report's
existing memory bounds. CLI turn-history discovery uses bounded filesystem
concurrency when enabled. The timeline graph renders
at most 200 points and discloses the displayed count and any producer truncation.

CLI date filters use the same local-day semantics as the desktop: `--period week`
or `--from 2026-10-01 --to 2026-10-02`. Explicit dates override the period; `--since`
can further narrow the start. No date flag preserves the original CLI behavior.

## Trend and typical day

Providers change serving stacks, quantization and capacity without notice. The
trend and the typical day make that visible.

- **Trend (desktop).** Below the table, a chart shows the selected row's median
  generation tok/s and median first arrival per interval: per hour for windows up
  to two days, per day up to 120 days, per Monday-aligned week beyond that, all in
  local time. Intervals without complete requests stay gaps. The Trend column has
  a sparkline per row; click it to chart that row. Hover the chart for the
  interval's request count.
- **Typical day.** With `--typical-days n`, each row also gets the median of its
  daily medians over the n whole local days before the window's first day. A
  buffered row (below) gets no typical generation rate. A day needs at least five
  requests, the typical day at least three such days, and the window at least five
  requests before a change is reported, so one busy day or a thin window cannot
  drive it. A change of 25% or more is a shift: green when it helps (faster
  generation, earlier first arrival), amber or orange when it hurts. Ordinary days
  in real ZCode history moved about ±20%.
- **Where.** The desktop shows the typical value and change under each number,
  and as a dashed line on the chart. The macOS menubar and the Capacity Dock
  compare the last 24 hours with the seven days before them.

Workload changes move these numbers too: longer contexts, more reasoning or a
different mix of tasks. Treat a shift as a prompt to look, not a verdict on the
provider.

JSON adds `trend.bucket` and `trend.starts` (interval starts), `rows[].trend`
(per-interval medians and request counts, aligned with `trend.starts`, `null` for
gaps), `rows[].typical` (`null` without enough earlier data) and `typicalDays`.
Open-ended windows and the long `all`/`lifetime` periods carry no typical day:
the week before them says nothing about now. When the ZCode read fills
`--history-limit` (CLI default 100), a warning says older requests in the window
were left out, so they never read as idle intervals.

## What each number measures

| Field | Meaning |
|---|---|
| Generation Tok/s p50 | Median of `(output tokens - 1) / seconds after first arrival`. Native tokens use first-to-last-token timing; chunks use first-to-last-chunk timing and are estimates. Request-only logs use request completion minus first-token time and are also estimates. Chunk and request estimates need at least 1 s after the first arrival. |
| bufferedDelivery (JSON) | `true` when most of a row's requests ended within a second of their first arrival. The delivery path buffers, so the row shows no generation rate (`—`, "buffered"); first arrival still applies. In real ZCode history, Gemini through the `custom:antigravity` provider delivered half its replies within 170 ms of the first chunk, which read as 3,400 tok/s. |
| First ms p50 / p95 | Delay to the first generated emission: a native token, ZCode's recorded first token, a proxy SSE chunk, or an Antigravity CLI delta. Heartbeats, role declarations and usage events do not start the clock. |
| Duration ms p50 / p95 | Distribution of complete timed requests. Codex's duration is estimated model wait at turn granularity. |
| Generation / observed | Requests with enough data for generation speed / all observations, including incomplete or unavailable samples. One output token, one streamed chunk, missing first arrival, or turn-only timing cannot establish generation speed. |
| interTokenMsP50 / P95 (JSON) | Intervals between individual native tokens, only when the complete token timeline is available. Never calculated by spreading a chunk's tokens evenly across its duration. |
| effectiveTokensPerSecond (JSON only) | Sum of generated tokens / sum of observed request/run seconds, including initial wait. Codex's turn estimate excludes tools; Antigravity's window begins at `init`. This is a separate diagnostic, not the displayed generation speed. |

The generation formula is the inverse of time per output token (TPOT), excluding
the first token and its latency, as defined in [vLLM's metrics documentation](https://github.com/vllm-project/vllm/blob/main/docs/design/metrics.md).
CodeBurn uses the observed last emission where available; request completion is
an explicitly estimated endpoint when only request-level timing exists. The JSON
fields are `generationTokensPerSecondP50`, `generationRateEstimated` and
`generationRequests`. No valid generation interval means `null`, with no fallback
to the end-to-end or turn rate.

`~` marks an estimate. Reasoning and generated tool arguments may be included
in output usage; these are generation rates, not only the speed of visible prose.
Short or buffered streams can yield misleading estimates; use longer, comparable
generations for useful comparisons. Compare similar context lengths, reasoning
settings and workloads. Timing is
client-observed arrival time, not the provider's internal GPU decode time.

Interrupted/error/incomplete requests remain visible in the sample counts but
are excluded from complete-request throughput and percentiles. Missing timing
is `null`/`-`, never zero. Capture sources remain separate because a native log
and a proxy can observe the same request; do not sum their request counts.

## Coverage of the six harnesses

| Harness | Existing local history | Opt-in streaming capture |
|---|---|---|
| Codex | Existing generated-token/model-wait estimates from completed turns remain JSON diagnostics. They lack first-token timing, so generation tok/s is unavailable. Multi-model turns are excluded. | HTTP OpenAI Responses SSE through the proxy when the configured provider supports a base-URL override. WebSocket transport is not supported. The normal ChatGPT transport is not automatically rerouted. |
| Claude Code | Its assistant JSONL does not provide an individual-token timeline to this reader. | Anthropic SSE through a per-run `ANTHROPIC_BASE_URL` override; native individual-token events can use the collector. |
| ZCode | Read-only `model_usage` request start/end and optional `first_token_at`. Generation tok/s uses `(N-1)/(completed_at-first_token_at)` as an estimate; completion is not a token timestamp. Missing status/first-token data leaves generation speed unavailable. | Proxy when that provider's endpoint is configurable; otherwise a native producer must submit timing events. |
| DeepSeek Harness (`dsh`) | The existing spend reader supports session formats v0–v3, without individual-token timestamps. The installed client tested here writes v4, which that history reader skips. | Its native DeepSeek Messages adapter or a configurable OpenAI-compatible SSE provider through the proxy, or native timing submission. Live streaming does not depend on the session-file version. |
| Hermes | Session token aggregates do not establish per-request/per-token timing. | Configurable OpenAI/Anthropic HTTP provider through the proxy, or native timing submission. |
| Antigravity | The usage/RPC/database reader does not establish per-token timing. | Pipe one `agy --output-format stream-json --print ...` run through `speed capture-antigravity` for CLI delta timestamps and final token usage. The desktop/IDE transport is not automatically instrumented. |

The report explicitly lists harnesses without eligible generation timings. Installing
a harness alone does not provide streaming timing. The collector contract
supports all six identities, but actual capture depends on the producer or a
supported HTTP/CLI stream; this is not a claim of automatic per-token coverage.

## Capture streaming requests through a local proxy

```sh
codeburn speed proxy --harness claude --upstream https://api.anthropic.com --port 4319
```

In a separate shell, direct only the desired run through it:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:4319 claude
```

Use a separate proxy/port for each harness attribution. `--upstream` is an
origin, without an API path; preserve the provider's API path in the client's
base URL. For example, an OpenAI-compatible client with `/v1` uses
`http://127.0.0.1:4319/v1` and an upstream such as `https://api.openai.com`.
Use the client's existing credentials; the proxy forwards them and never
stores them. It does not install credentials, certificates, hooks, or change
global environment/configuration. Some subscription clients restrict custom
endpoints: an unsuccessful override is not proof of supported capture.

### DeepSeek Harness and Hermes

Both paths below were checked with real, isolated runs using the clients'
existing credentials. Both returned `SPEED_PROBE_OK`; their own output usage
matched the proxy's six generated tokens. Each stream had six emission events,
which still remain `chunk` observations rather than an asserted token timeline.
The response model ID was `deepseek-flash` in both harnesses, including Hermes's
request under the `deepseek-chat` alias.

For DeepSeek Harness's API-key Messages provider, start a proxy with `--harness dsh
--upstream https://api.deepseek.com --port 4320`. A temporary `--patch` file can
route a headless run without editing the desktop profile:

```yaml
- id: llm-deepseek
  config:
    baseURL: http://127.0.0.1:4320/anthropic
    apiKeyEnv: DEEPSEEK_API_KEY
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
```

```sh
dsh headless --patch ./speed-probe.yml 'Reply exactly SPEED_PROBE_OK.'
```

This verifies DeepSeek Harness's API-key provider. The desktop account provider restricts
credential destinations; that login route was not exercised through the proxy.
The installed DeepSeek Harness runtime writes `session.v4.jsonl.zstd`. This PR's live speed
capture reads its HTTP stream, while CodeBurn's existing v0–v3 spend/history
parser skips v4; `codeburn doctor --provider dsh` reported one skipped local
session. Adding v4 history semantics is separate from this speed capture path.

For Hermes, start another proxy with `--harness hermes --upstream
https://api.deepseek.com --port 4321`. In the desired Hermes profile, a named
custom provider can select the endpoint and the existing credential variable:

```yaml
providers:
  speedprobe:
    base_url: http://127.0.0.1:4321/v1
    key_env: DEEPSEEK_API_KEY
    api_mode: chat_completions
    default_model: deepseek-chat
```

```sh
hermes chat --provider speedprobe --model deepseek-chat --oneshot \
  -q 'Reply exactly SPEED_PROBE_OK.'
```

Use a temporary profile for a probe. The checked path is the configurable HTTP
provider; Hermes's default Codex subscription route was not automatically
instrumented. A rejected credential remains an error sample and contributes no
complete-request speed.

The proxy binds only `127.0.0.1`, has a fixed upstream, rejects browser-origin
requests and URL credentials, and allows plaintext upstreams only on loopback.
It forwards request bodies and response bytes with streaming backpressure.
OpenAI Chat Completions/Responses and Anthropic Messages SSE are observed.
It removes compression negotiation to observe SSE; compressed responses from
servers that ignore this, non-streaming replies and WebSockets do not produce
a complete streaming measurement. An upstream failure/cancellation is retained
as incomplete telemetry rather than an invented speed.

Each generated SSE delta gets an arrival timestamp. One delta can contain
several tokens; **SSE events are stored with resolution `chunk`**. The proxy does
not tokenize text, retain text, or convert characters to guessed token counts.
Final provider usage supplies the output total. A complete stream without final
usage remains incomplete for rate calculations.

## Capture Antigravity CLI deltas

```sh
agy --model gemini-3.8-flash-low --mode plan --sandbox \
  --disable-slash-commands --output-format stream-json \
  --print 'Reply exactly SPEED_PROBE_OK. Do not call tools or read files.' |
  codeburn speed capture-antigravity

codeburn speed --harness antigravity --no-history
```

The adapter reads the CLI's native `init`, `step_update` and `result` NDJSON
frames, forwards stdout bytes unchanged, and saves only timing/counter metadata
with source `antigravity-cli` and resolution `chunk`. `--file` selects another
local telemetry file. It uses the client's existing login without changing
global configuration or routing credentials through a proxy.

This path was verified with the installed Antigravity CLI, including a real
`gemini-3.8-flash-low` run that returned `SPEED_PROBE_OK`. Final CLI input/output
usage matched the stored counters. A delta can contain several tokens; matching
usage does not establish individual-token timestamps. Thinking tokens are
already included in `output_tokens`, so they are recorded as detail and never
added to the output total a second time.

Timings use one local arrival clock from `init` to `result`, excluding CLI
startup before `init`. First/last emissions include nonempty text or thinking
deltas. The adapter does not combine the CLI-reported
`duration_seconds` with local arrival timestamps. The first-token and stream
rates describe CLI delivery, which can batch deltas, rather than GPU decode.

Only a single-turn run with one agent response step and no tool steps can
contribute a complete per-model measurement. Tool runs, multiple response steps
or aggregated turns remain `incomplete` at `turn` resolution because the final
usage can combine different generations/models. Missing model/usage, malformed
frames and mismatched conversation identities also remain incomplete. Early
EOF or cancellation retains partial timing as interrupted; none of these
samples contributes a complete-request rate. Desktop/IDE timing still needs a
producer that observes its stream.

## Capture individual native tokens

```sh
codeburn speed collect --port 4319
```

A harness/provider integration that genuinely receives individual-token
boundaries submits a completed sample to `POST http://127.0.0.1:4319/v1/speed`,
with `Content-Type: application/json` and `X-Codeburn-Speed: 1`.
Take monotonic elapsed timestamps at the boundary, rather than interpolating
them after completion. The following is a **synthetic protocol example**:

```json
{
  "version": 1,
  "id": "example-request",
  "harness": "hermes",
  "model": "example-model",
  "source": "native",
  "resolution": "token",
  "startedAt": "2026-10-01T09:00:00Z",
  "durationMs": 1000,
  "firstEmissionMs": 100,
  "lastEmissionMs": 500,
  "outputTokens": 3,
  "status": "complete",
  "events": [
    { "elapsedMs": 100, "tokens": 1 },
    { "elapsedMs": 300, "tokens": 1 },
    { "elapsedMs": 500, "tokens": 1 }
  ]
}
```

`events` contain elapsed milliseconds, not text or token IDs. A complete token
timeline must have one event per output token, ordered within the request
duration, with matching first/last timestamps. If the API batches tokens or
hides reasoning tokens, submit `resolution: "chunk"` or the appropriate
incomplete status, rather than claiming individual-token coverage. Producers
may supply `inputTokens`/`reasoningTokens` as additional counters; output counts
must represent the same generated tokens as the timeline.

Unknown producer fields are discarded before storage. Prompt/response bodies,
credentials, HTTP headers, token IDs, project paths and tool arguments are not
retained. At most 100,000 emission timestamps are retained per captured request/run;
longer timelines are marked truncated. Truncated timelines do not contribute
individual-token interval percentiles.
