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
