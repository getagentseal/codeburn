import { describe, expect, it } from 'vitest'

import { decodeDevin, toObservations } from '../../src/providers/devin/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { DevinAgentTrajectory, DevinDecodeRecord, DevinSessionMetadata } from '../../src/providers/devin/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'devin', sourceRef: '/tmp/devin/transcripts/sess-a.json' }

function makeRecord(
  transcript: DevinAgentTrajectory,
  session: DevinSessionMetadata | null = null,
  project = 'devin',
  sessionId?: string,
): DevinDecodeRecord {
  return { transcript, session, project, sessionId: sessionId ?? transcript.session_id ?? 'sess-a' }
}

const BASE_TRANSCRIPT: DevinAgentTrajectory = {
  schema_version: '1.7',
  session_id: 'sess-a',
  agent: { name: 'devin', version: '2.0', model_name: 'agent-model' },
  steps: [],
}

const BASE_SESSION: DevinSessionMetadata = {
  id: 'sess-a',
  workingDirectory: '/Users/me/projects/codeburn',
  model: 'claude-sonnet-4-6',
  title: 'Test',
  createdAt: '2027-01-15T08:00:00.000Z',
  lastActivityAt: '2027-01-15T08:00:10.000Z',
  hidden: false,
}

describe('devin rich decode (moved to @codeburn/core)', () => {
  it('decodes assistant calls into cost-free rich calls, skipping user-input and empty steps', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          message: 'fix the bug',
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          source: 'assistant',
          model_name: 'step-model',
          message: 'reading file',
          tool_calls: [{ tool_call_id: 'tc1', function_name: 'read_file', arguments: { path: 'src/main.ts' } }],
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            generation_model: 'claude-opus-4-6',
            metrics: { input_tokens: 100, output_tokens: 20, cache_creation_tokens: 10, cache_read_tokens: 5 },
          },
        },
        {
          step_id: 3,
          source: 'assistant',
          message: 'empty step',
          metadata: { created_at: '2027-01-15T08:00:02.000Z' },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript, BASE_SESSION)], context })
    expect(calls).toHaveLength(1)

    const call = calls[0]!
    expect(call.provider).toBe('devin')
    expect(call.generationModel).toBe('claude-opus-4-6')
    expect(call.inputTokens).toBe(100)
    expect(call.outputTokens).toBe(20)
    expect(call.cacheCreationInputTokens).toBe(10)
    expect(call.cacheReadInputTokens).toBe(5)
    expect(call.cachedInputTokens).toBe(5)
    expect(call.reasoningTokens).toBe(0)
    expect(call.webSearchRequests).toBe(0)
    expect(call.tools).toEqual(['read_file'])
    expect(call.rawBashCommands).toEqual([])
    expect(call.userMessage).toBe('fix the bug')
    expect(call.deduplicationKey).toBe('devin:sess-a:2')
    expect(call.sessionId).toBe('sess-a')
    expect(call.project).toBe('codeburn')
    expect(call.projectPath).toBe('/Users/me/projects/codeburn')
    expect(call.committedAcuCost).toBe(0.1)
    // No pricing crosses into the decode layer.
    expect(call).not.toHaveProperty('costUSD')
    expect(call).not.toHaveProperty('costBasis')
  })

  it('threads a live seenKeys set so a repeated step drops across passes', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 2,
          source: 'assistant',
          message: 'working',
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 10 },
          },
        },
      ],
    }

    const seen = new Set<string>()
    const first = decodeDevin({ records: [makeRecord(transcript)], context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeDevin({ records: [makeRecord(transcript)], context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('prefers step.metrics over metadata.metrics when both are present', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          metrics: {
            prompt_tokens: 500,
            completion_tokens: 100,
            cached_tokens: 20,
            extra: { cache_creation_input_tokens: 30 },
          },
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 1, cache_read_tokens: 1 },
          },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript)], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[0]!.outputTokens).toBe(100)
    expect(calls[0]!.cacheCreationInputTokens).toBe(30)
    expect(calls[0]!.cacheReadInputTokens).toBe(20)
  })

  it('falls back to metadata.metrics when step.metrics is present but empty', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          metrics: {},
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 80, output_tokens: 20, cache_read_tokens: 5 },
          },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript)], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(80)
    expect(calls[0]!.outputTokens).toBe(20)
    expect(calls[0]!.cacheReadInputTokens).toBe(5)
  })

  it('reads ACU cost from step.extra when metadata.committed_acu_cost is absent', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          extra: { committed_acu_cost: 0.3 },
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            metrics: { input_tokens: 10 },
          },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript)], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.committedAcuCost).toBe(0.3)
  })

  it('prefers metadata.committed_acu_cost over extra.committed_acu_cost', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          extra: { committed_acu_cost: 0.99 },
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.11,
            metrics: { input_tokens: 10 },
          },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript)], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.committedAcuCost).toBe(0.11)
  })

  it('uses the host-supplied session id verbatim for session id and dedup key', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      session_id: undefined,
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 10 },
          },
        },
      ],
    }

    // The transcript omits session_id, so the host derived the id from the
    // filename and passed it in; the decoder never re-derives it.
    const { calls } = decodeDevin({
      records: [makeRecord(transcript, null, 'devin', 'fallback-session')],
      context: { ...context, sourceRef: '/tmp/devin/transcripts/fallback-session.json' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('fallback-session')
    expect(calls[0]!.deduplicationKey).toBe('devin:fallback-session:1')
  })

  it('emits the RAW generation_model and model_name ids, never a display name', () => {
    // Display formatting needs the host's model table and stays CLI-side; the
    // decoder only resolves which raw id wins each precedence chain.
    const cases: Array<{ generationModel: string; modelName: string }> = [
      { generationModel: 'gpt-5-3-codex-xhigh', modelName: 'GPT-5.4' },
      { generationModel: 'gpt-5-4-low', modelName: 'GPT-5.5' },
      { generationModel: 'MODEL_PRIVATE_11', modelName: 'Gemini 3 Flash' },
      { generationModel: 'claude-opus-4-6', modelName: 'agent-model' },
    ]

    for (const row of cases) {
      const transcript: DevinAgentTrajectory = {
        ...BASE_TRANSCRIPT,
        session_id: `model-${row.generationModel}`,
        agent: { ...BASE_TRANSCRIPT.agent, model_name: row.modelName },
        steps: [
          {
            step_id: 1,
            source: 'assistant',
            message: 'working',
            metadata: {
              created_at: '2027-01-15T08:00:00.000Z',
              committed_acu_cost: 0.1,
              generation_model: row.generationModel,
              metrics: { input_tokens: 1 },
            },
          },
        ],
      }

      const { calls } = decodeDevin({
        records: [makeRecord(transcript)],
        context: { ...context, sourceRef: `/tmp/devin/transcripts/model-${row.generationModel}.json` },
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.generationModel).toBe(row.generationModel)
      expect(calls[0]!.modelName).toBe(row.modelName)
    }
  })

  it('acceptance: a display-name model name (e.g. "Gemini 3 Flash") is normalized at the observation boundary', () => {
    // When no generation_model is recorded, devin falls back to the agent's
    // model_name, which real databases carry as a display name ("Gemini 3
    // Flash"). The observation boundary must normalize it to 'unknown'
    // instead of rejecting the whole envelope.
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      agent: { name: 'devin', version: '2.0', model_name: 'Gemini 3 Flash' },
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 100 },
          },
        },
      ],
    }
    const { calls } = decodeDevin({ records: [makeRecord(transcript)], context })
    expect(calls[0]!.generationModel).toBeUndefined()
    expect(calls[0]!.modelName).toBe('Gemini 3 Flash')

    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'devin' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]!.calls[0]!.model).toBe('unknown')
    expect(JSON.stringify(envelope)).not.toContain('Gemini 3 Flash')
  })

  it('extracts user message from ContentPart[] messages', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          message: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { media_type: 'image/png', path: '/tmp/screenshot.png' } },
          ],
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          source: 'assistant',
          message: 'working',
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 50 },
          },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript)], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('look at this /tmp/screenshot.png')
  })

  it('skips sessions hidden in sessions.db', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 10 },
          },
        },
      ],
    }

    const hiddenSession: DevinSessionMetadata = { ...BASE_SESSION, hidden: true }
    const { calls } = decodeDevin({ records: [makeRecord(transcript, hiddenSession)], context })
    expect(calls).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          message: 'fix the bug',
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          source: 'assistant',
          message: 'reading file',
          tool_calls: [{ tool_call_id: 'tc1', function_name: 'read_file', arguments: { path: 'src/main.ts' } }],
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 100 },
          },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript, BASE_SESSION)], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'devin' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
  })

  it('toObservations emits measured cost basis', () => {
    const transcript: DevinAgentTrajectory = {
      ...BASE_TRANSCRIPT,
      steps: [
        {
          step_id: 1,
          source: 'assistant',
          message: 'working',
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.5,
            metrics: { input_tokens: 100 },
          },
        },
      ],
    }

    const { calls } = decodeDevin({ records: [makeRecord(transcript)], context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'devin' },
    )
    expect(sessions[0]!.calls[0]!.costBasis).toBe('measured')
  })
})
