// Regression test for issue #654: Copilot JSONL parser drops skill invocations,
// leaving the Skills & Agents section empty for Copilot CLI sessions.
//
// Copilot CLI (~/.copilot/session-state/<id>/events.jsonl) records skill usage
// as assistant.message toolRequests with name === 'skill' and the skill name in
// arguments.skill. The parser must:
//   1. normalise the tool name to 'Skill' (classifier's hasSkillTool matches
//      exactly 'Skill', which makes the turn 'general'), and
//   2. populate ParsedProviderCall.skills with the invoked skill name(s)
//      (getAllSkills -> turn.subCategory -> skillBreakdown -> Skills report).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { copilot } from '../../src/providers/copilot.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

async function createSessionDir(sessionId: string, lines: string[], cwd = '/home/user/myproject') {
  const sessionDir = join(tmpDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'workspace.yaml'), `id: ${sessionId}\ncwd: ${cwd}\n`)
  await writeFile(join(sessionDir, 'events.jsonl'), lines.join('\n') + '\n')
  return join(sessionDir, 'events.jsonl')
}

function modelChange(newModel: string) {
  return JSON.stringify({ type: 'session.model_change', timestamp: '2026-07-09T16:18:00Z', data: { newModel } })
}

function userMessage(content: string) {
  return JSON.stringify({ type: 'user.message', timestamp: '2026-07-09T16:18:05Z', data: { content, interactionId: 'int-1' } })
}

// Mirrors the real Copilot CLI event shape reported in issue #654.
function assistantMessageWithSkill(opts: { messageId: string; skill: string }) {
  return JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-07-09T16:18:12.463Z',
    data: {
      messageId: opts.messageId,
      model: 'claude-sonnet-4.6',
      outputTokens: 111,
      toolRequests: [
        {
          toolCallId: 'toolu_bdrk_01FrUw1ya3xi7MNK5aRK8LVc',
          name: 'skill',
          arguments: { skill: opts.skill },
          type: 'function',
        },
      ],
    },
  })
}

async function collectCalls(eventsPath: string) {
  const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
  const calls: ParsedProviderCall[] = []
  for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)
  return calls
}

describe('copilot provider - skill invocations (issue #654)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-skills-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('normalizes the "skill" tool name to "Skill" so the classifier recognises it', async () => {
    const eventsPath = await createSessionDir('sess-skill-1', [
      modelChange('claude-sonnet-4.6'),
      userMessage('use the deploy skill'),
      assistantMessageWithSkill({ messageId: 'msg-1', skill: 'deploy-checklist' }),
    ])

    const calls = await collectCalls(eventsPath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toContain('Skill')
  })

  it('populates skills[] with the skill name from arguments.skill', async () => {
    const eventsPath = await createSessionDir('sess-skill-2', [
      modelChange('claude-sonnet-4.6'),
      userMessage('use the deploy skill'),
      assistantMessageWithSkill({ messageId: 'msg-1', skill: 'deploy-checklist' }),
    ])

    const calls = await collectCalls(eventsPath)

    expect(calls).toHaveLength(1)
    // Feeds getAllSkills() -> turn.subCategory -> skillBreakdown -> Skills & Agents section.
    expect(calls[0]!.skills).toEqual(['deploy-checklist'])
  })
})
