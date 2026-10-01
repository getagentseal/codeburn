# Generation speed by model and harness

`codeburn speed` reports local timing samples grouped by **harness, actual model
ID, source and timing resolution**. A model used in Claude Code and Hermes has
separate rows. The speed report does not rewrite model IDs to pricing aliases.
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

## What each number measures

| Field | Meaning |
|---|---|
| Effective Tok/s | Sum of generated tokens / sum of timed request seconds. Includes request/network/prefill latency; Codex's existing estimate excludes tool execution. |
| Stream Tok/s p50 | Median rate between first and last emission. Native individual tokens use `(N-1)/(last-first)`. For chunks this is an estimate using the final usage count; missing usage produces no rate. |
| First ms p50 / p95 | Delay to the first generated emission: a native token, ZCode's recorded first token, or a proxy SSE chunk. Heartbeats, role declarations and usage events do not start the clock. |
| Duration ms p50 / p95 | Distribution of complete timed requests. Codex's duration is estimated model wait at turn granularity. |
| interTokenMsP50 / P95 (JSON) | Intervals between individual native tokens, only when the complete token timeline is available. Never calculated by spreading a chunk's tokens evenly across its duration. |

`~` marks an estimate. Reasoning and generated tool arguments may be included
in output usage; these are generation rates, not only the speed of visible prose.
Compare similar context lengths, reasoning settings and workloads. Timing is
client-observed arrival time, not the provider's internal GPU decode time.

Interrupted/error/incomplete requests remain visible in the sample counts but
are excluded from complete-request throughput and percentiles. Missing timing
is `null`/`-`, never zero. Capture sources remain separate because a native log
and a proxy can observe the same request; do not sum their request counts.

## Coverage of the six harnesses

| Harness | Existing local history | Opt-in streaming capture |
|---|---|---|
| Codex | Existing generated-token/model-wait estimates from completed turns. Multi-model turns are excluded because timings are not observed separately. | HTTP OpenAI Responses SSE through the proxy when the configured provider supports a base-URL override. WebSocket transport is not supported. The normal ChatGPT transport is not automatically rerouted. |
| Claude Code | Its assistant JSONL does not provide an individual-token timeline to this reader. | Anthropic SSE through a per-run `ANTHROPIC_BASE_URL` override; native individual-token events can use the collector. |
| ZCode | Read-only `model_usage` request start/end and optional `first_token_at`. `completed_at` is **not** treated as the last token's timestamp. Older schemas without status/first-token data remain incomplete/unknown. | Proxy when that provider's endpoint is configurable; otherwise a native producer must submit timing events. |
| DeepSeek Harness (`dsh`) | Existing compacted session formats are not interpreted as individual-token timestamps. | OpenAI-compatible SSE when the selected provider supports a base-URL override, or native timing submission. |
| Hermes | Session token aggregates do not establish per-request/per-token timing. | Configurable OpenAI/Anthropic HTTP provider through the proxy, or native timing submission. |
| Antigravity | The usage/RPC/database reader does not establish per-token timing. | A native timing producer is required. Starting the collector does not instrument its proprietary model transport. |

The report explicitly lists harnesses without complete timed samples. Installing
a harness alone does not provide streaming timing. The collector contract
supports all six identities, but actual capture depends on the producer or a
supported HTTP stream; this is not a claim of automatic per-token coverage.

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
retained. At most 100,000 emission timestamps are retained per proxy request;
longer timelines are marked truncated. Truncated timelines do not contribute
individual-token interval percentiles.
