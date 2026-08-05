import { describe, expect, it } from 'vitest'

import { decodeGrok, toObservations } from '../../src/providers/grok/index.js'
import { sourceRefFingerprint } from '../../src/fingerprint.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { GrokSessionRecords } from '../../src/providers/grok/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'grok', sourceRef: 'ref' }

function sessionRecord(opts: {
  updatesLines: string[]
  summary?: Partial<GrokSessionRecords['summary']>
  signals?: GrokSessionRecords['signals']
  sourceDir?: string
  sessionName?: string
  project?: string
}): GrokSessionRecords {
  return {
    summary: {
      info: { id: 'sess-1', cwd: '/Users/test/project' },
      created_at: '2026-06-19T11:20:40.686261Z',
      updated_at: '2026-06-19T11:31:12.282793Z',
      last_active_at: '2026-06-19T11:31:12.222328Z',
      current_model_id: 'grok-build',
      session_summary: 'User asks about the repo',
      generated_title: 'User asks about the repo',
      ...opts.summary,
    },
    signals: opts.signals ?? null,
    updatesLines: opts.updatesLines,
    sourceDir: opts.sourceDir ?? '/sessions/%2FUsers%2Ftest/sess-1',
    sessionName: opts.sessionName ?? 'sess-1',
    project: opts.project ?? 'project',
  }
}

function updateLine(opts: {
  totalTokens?: number
  promptId?: string
  title?: string
  rawInput?: Record<string, unknown>
}): string {
  return JSON.stringify({
    timestamp: '2026-06-19T11:30:00.000Z',
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: opts.title ? 'tool_call' : 'agent_message_chunk',
        ...(opts.title ? { title: opts.title, toolCallId: 'c1', rawInput: opts.rawInput } : { content: { type: 'text', text: 'hi' } }),
      },
      _meta: {
        ...(opts.totalTokens !== undefined ? { totalTokens: opts.totalTokens } : {}),
        ...(opts.promptId ? { promptId: opts.promptId } : {}),
      },
    },
  })
}

describe('grok rich decode (moved to @codeburn/core)', () => {
  it('decodes one session from updates.jsonl into a cost-free rich call', () => {
    const records: GrokSessionRecords[] = [
      sessionRecord({
        updatesLines: [
          updateLine({ totalTokens: 20000, promptId: 'p1' }),
          updateLine({ totalTokens: 25000, promptId: 'p1' }),
          updateLine({ totalTokens: 30000, promptId: 'p2' }),
          updateLine({ totalTokens: 35000, promptId: 'p2' }),
          updateLine({ title: 'read_file', rawInput: { target_directory: '.' } }),
          updateLine({ title: 'run_terminal_command', rawInput: { command: 'npm test && git status' } }),
          updateLine({ title: 'spawn_subagent', rawInput: { subagent_type: 'general-purpose' } }),
        ],
      }),
    ]

    const { calls } = decodeGrok({ records, context })
    expect(calls).toHaveLength(1)

    const call = calls[0]!
    expect(call.provider).toBe('grok')
    expect(call.model).toBe('grok-build')
    expect(call.inputTokens).toBe(35000)
    expect(call.outputTokens).toBe(10000)
    expect(call.cacheReadInputTokens).toBe(15000)
    expect(call.cachedInputTokens).toBe(15000)
    expect(call.tools).toEqual(['Read', 'Bash', 'Agent'])
    // Raw commands stay raw; base-name extraction is the host's job.
    expect(call.rawBashCommands).toEqual(['npm test && git status'])
    expect(call.subagentTypes).toEqual(['general-purpose'])
    expect(call.userMessage).toBe('User asks about the repo')
    expect(call.sessionId).toBe('sess-1')
    expect(call.project).toBe('project')
    expect(call.projectPath).toBe('/Users/test/project')
    // The dedup key threads a FINGERPRINT of the session dir, never the raw
    // path — dedupKey ships on the envelope.
    expect(call.deduplicationKey).toBe(`grok:${sourceRefFingerprint('k', '/sessions/%2FUsers%2Ftest/sess-1')}:2026-06-19T11:31:12.282793Z:sess-1`)
    expect(call.deduplicationKey).not.toContain('/sessions/')
  })

  it('sums fresh input across compaction segments', () => {
    const records: GrokSessionRecords[] = [
      sessionRecord({
        updatesLines: [
          updateLine({ totalTokens: 100000, promptId: 'p1' }),
          updateLine({ totalTokens: 400000, promptId: 'p1' }),
          // Large drop (>50%) simulates compaction.
          updateLine({ totalTokens: 20000, promptId: 'p2' }),
          updateLine({ totalTokens: 50000, promptId: 'p2' }),
        ],
      }),
    ]

    const { calls } = decodeGrok({ records, context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(450000)
  })

  it('skips zero-token sessions', () => {
    const records: GrokSessionRecords[] = [
      sessionRecord({
        updatesLines: [
          updateLine({ totalTokens: 0, promptId: 'p1' }),
          updateLine({ totalTokens: 0, promptId: 'p1' }),
        ],
      }),
    ]

    expect(decodeGrok({ records, context }).calls).toEqual([])
  })

  it('threads a live seenKeys set so a repeated session drops', () => {
    const records: GrokSessionRecords[] = [
      sessionRecord({
        updatesLines: [updateLine({ totalTokens: 1000, promptId: 'p1' })],
      }),
    ]

    const seen = new Set<string>()
    expect(decodeGrok({ records, context, seenKeys: seen }).calls).toHaveLength(1)
    expect(decodeGrok({ records, context, seenKeys: seen }).calls).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const records: GrokSessionRecords[] = [
      sessionRecord({
        updatesLines: [
          updateLine({ totalTokens: 1000, promptId: 'p1' }),
          updateLine({ title: 'read_file', rawInput: { file_path: 'src/app.ts' } }),
        ],
      }),
    ]

    const { calls } = decodeGrok({ records, context })
    const { sessions } = toObservations(
      { sessionId: 'sess-1', projectPath: '/Users/test/project', calls },
      { privacyKey: 'test-privacy-key', provider: 'grok' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    // Grok does not capture per-tool file paths, so there are no resource refs.
    const reads = sessions.flatMap(s => s.calls.flatMap(c => c.resourceReads ?? []))
    expect(reads).toEqual([])
  })
})
