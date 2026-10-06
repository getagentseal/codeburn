# Mistral Vibe Unified Harness fixture

`mistral-vibe-unified.json` contains two snapshots written by the unmodified
Mistral Vibe **2.25.8** CLI on macOS, using `--experimental-harness --trust
--disabled-tools '*' --max-turns 1 --output json -p ...`. The second invocation
uses `--continue` to resume the first session.

The API was a local HTTP SSE fixture, not a paid Mistral response. It returned:

| Turn | Prompt tokens (includes cache) | Cached prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: |
| 1 | 120 | 80 | 15 |
| 2 | 128 | 64 | 10 |

The CLI's actual storage, projection updates, generation publication, history
chunks, and journal rotation produced the fixture. After the second invocation,
the first journal segment has been removed. Expected CodeBurn totals are 104
uncached input, 144 cache-read input, and 25 output tokens: **273 total**.

The fixture preserves the selected CURRENT generation, its manifest and
projection, the referenced history chunks, and relevant journal records. Unused
runtime state and metadata were removed, and the working directory was replaced
with `/tmp/vibe-repro`. Embedded hashes are original provenance values, not
checksums of these minimized documents. No credentials or private conversation
content are included.

## Vibe 2.26.0 fixture

`mistral-vibe-unified-2.26.json` is a real Vibe **2.26.0** session against the
Mistral API: two prompts, 11 completions, no model pin (default
`mistral-medium-3.5`). The first prompt's journal segment had already rotated
away, so only the second prompt's 5 calls keep per-call usage. Totals:
142,427 input tokens of which 131,200 cached, 1,216 output. All prompt, file,
tool-output and title text is replaced with `redacted`, bash commands with
`python3 -m unittest`, and the working directory with `/tmp/vibe-test`.
Runtime state keeps only session metadata and action kinds and states; the
journal keeps cumulative envelopes and the usage of each completion.
