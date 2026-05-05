import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, it, expect } from 'vitest'

import { buildRedactedShare, redactForShare, writeRedactedShare } from '../src/share.js'
import type { ProjectSummary } from '../src/types.js'

describe('redacted share', () => {
  it('redacts common secrets, emails, and local paths', () => {
    const openAiProjectKey = `sk-proj-${'abcdefghijklmnopqrstuvwxyz123456'}`
    const githubPat = `ghp_${'abcdefghijklmnopqrstuvwxyz123456'}`
    const githubServerToken = `ghs_${'abcdefghijklmnopqrstuvwxyz123456'}`
    const jwt = `eyJ${'abcdefghijklmnopqrstuvwxyz'}.eyJ${'abcdefghijklmnopqrstuvwxyz'}.signatureabcdefghijkl`
    const slackToken = `xox${'b'}-123456789012-abcdefghijklmnop`
    const stripeKey = `sk_${'live'}_abcdefghijklmnopqrstuvwxyz`
    const npmToken = `npm_${'abcdefghijklmnopqrstuvwxyz123456'}`
    const googleApiKey = `AI${'za'}abcdefghijklmnopqrstuvwxyz1234567890`
    const raw = [
      'email husam@example.com',
      'path /Users/husam/client-a/src/app.ts',
      'linux /srv/client-a/src/app.ts',
      'workspace /workspace/client-a/src/app.ts',
      'usr /usr/local/client-a/src/app.ts',
      'relative ../client-a/src/app.ts and ./src/private.ts <./angle/path.ts|./pipe/path.ts',
      'windows C:\\Users\\husam\\client-a\\src\\app.ts',
      'unc \\\\server\\share\\client-a\\notes.txt',
      `token ${openAiProjectKey}`,
      `Authorization: Bearer ${githubPat}`,
      `github server token ${githubServerToken}`,
      `jwt ${jwt}`,
      `slack ${slackToken}`,
      `stripe ${stripeKey}`,
      `npm ${npmToken}`,
      `api_key=${googleApiKey}`,
      'json {"password": "hunter2hunter2"}',
      'url https://alice:supersecretpass@example.com/repo',
    ].join('\n')

    const redacted = redactForShare(raw)

    expect(redacted).not.toContain('husam@example.com')
    expect(redacted).not.toContain('/Users/husam')
    expect(redacted).not.toContain('/srv/client-a')
    expect(redacted).not.toContain('/workspace/client-a')
    expect(redacted).not.toContain('/usr/local/client-a')
    expect(redacted).not.toContain('../client-a')
    expect(redacted).not.toContain('./src/private.ts')
    expect(redacted).not.toContain('./angle/path.ts')
    expect(redacted).not.toContain('./pipe/path.ts')
    expect(redacted).not.toContain('C:\\Users\\husam')
    expect(redacted).not.toContain('\\\\server\\share')
    expect(redacted).not.toContain(openAiProjectKey)
    expect(redacted).not.toContain(githubPat)
    expect(redacted).not.toContain(githubServerToken)
    expect(redacted).not.toContain(jwt)
    expect(redacted).not.toContain(slackToken)
    expect(redacted).not.toContain(stripeKey)
    expect(redacted).not.toContain(npmToken)
    expect(redacted).not.toContain(googleApiKey)
    expect(redacted).not.toContain('hunter2hunter2')
    expect(redacted).not.toContain('alice:supersecretpass')
    expect(redacted).toContain('[email:1]')
    expect(redacted).toContain('[path:1]')
    expect(redacted).toContain('[path:2]')
    expect(redacted).toContain('[path:3]')
    expect(redacted).toContain('[path:4]')
    expect(redacted).toContain('[path:5]')
    expect(redacted).toContain('[path:6]')
    expect(redacted).toContain('[path:7]')
    expect(redacted).toContain('[path:8]')
    expect(redacted).toContain('[path:9]')
    expect(redacted).toContain('[path:10]')
    for (let i = 1; i <= 10; i++) {
      expect(redacted).toContain(`[secret:${i}]`)
    }
  })

  it('builds a useful redacted support bundle', () => {
    const projects: ProjectSummary[] = [{
      project: 'client-a',
      projectPath: '/Users/husam/work/client-a',
      totalCostUSD: 1.23456,
      totalApiCalls: 1,
      sessions: [{
        sessionId: 'session-1',
        project: 'client-a',
        firstTimestamp: '2026-05-05T10:00:00.000Z',
        lastTimestamp: '2026-05-05T10:01:00.000Z',
        totalCostUSD: 1.23456,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalCacheReadTokens: 50,
        totalCacheWriteTokens: 25,
        apiCalls: 1,
        turns: [{
          userMessage: 'fix client-a at /Users/husam/work/client-a for husam@example.com with token=secret-token-12345',
          assistantCalls: [{
            provider: 'claude',
            model: 'claude-sonnet-4-5',
            usage: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheCreationInputTokens: 25,
              cacheReadInputTokens: 50,
              cachedInputTokens: 50,
              reasoningTokens: 0,
              webSearchRequests: 0,
            },
            costUSD: 1.23456,
            tools: ['Read', 'Bash'],
            mcpTools: [],
            skills: ['browser-use'],
            hasAgentSpawn: true,
            hasPlanMode: true,
            speed: 'standard',
            timestamp: '2026-05-05T10:01:00.000Z',
            bashCommands: ['npm'],
            deduplicationKey: 'dedupe',
          }],
          timestamp: '2026-05-05T10:00:00.000Z',
          sessionId: 'session-1',
          category: 'debugging',
          retries: 1,
          hasEdits: true,
        }],
        modelBreakdown: {},
        toolBreakdown: {},
        mcpBreakdown: {},
        bashBreakdown: {},
        categoryBreakdown: {},
        skillBreakdown: {},
      }],
    }]

    const share = buildRedactedShare(projects, {
      label: '7 Days',
      range: { start: new Date('2026-05-01T00:00:00.000Z'), end: new Date('2026-05-07T23:59:59.999Z') },
      provider: 'all',
      project: [],
      exclude: [],
    })

    expect(share.schema).toBe('codeburn.share.v1')
    expect(share.summary).toMatchObject({ projects: 1, sessions: 1, turns: 1, apiCalls: 1 })
    expect(share.projects[0]!.project).toBe('[project:1]')
    expect(share.projects[0]!.projectPath).toBe('[path:1]')
    expect(share.projects[0]!.sessions[0]!.totalCostUSD).toBe(1.2346)
    const message = share.projects[0]!.sessions[0]!.turns[0]!.userMessage
    const call = share.projects[0]!.sessions[0]!.turns[0]!.assistantCalls[0]!
    expect(message).not.toContain('/Users/husam')
    expect(message).not.toContain('husam@example.com')
    expect(message).not.toContain('secret-token-12345')
    expect(message).not.toContain('client-a')
    expect(message).toContain('[path:1]')
    expect(message).toContain('[email:1]')
    expect(message).toContain('[project:1]')
    expect(message).toContain('[secret:1]')
    expect(call.skills).toEqual(['browser-use'])
    expect(call.hasAgentSpawn).toBe(true)
    expect(call.hasPlanMode).toBe(true)
  })

  it('redacts project labels without mangling unrelated substrings', () => {
    const projects: ProjectSummary[] = [{
      project: 'api',
      projectPath: '/Users/husam/work/api',
      totalCostUSD: 0.01,
      totalApiCalls: 1,
      sessions: [{
        sessionId: 'session-1',
        project: 'api',
        firstTimestamp: '2026-05-05T10:00:00.000Z',
        lastTimestamp: '2026-05-05T10:01:00.000Z',
        totalCostUSD: 0.01,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        apiCalls: 1,
        turns: [{
          userMessage: 'API failed in api, but rapidapi and apiKey are library names',
          assistantCalls: [],
          timestamp: '2026-05-05T10:00:00.000Z',
          sessionId: 'session-1',
          category: 'debugging',
          retries: 0,
          hasEdits: false,
        }],
        modelBreakdown: {},
        toolBreakdown: {},
        mcpBreakdown: {},
        bashBreakdown: {},
        categoryBreakdown: {},
        skillBreakdown: {},
      }],
    }]

    const share = buildRedactedShare(projects, {
      label: '7 Days',
      range: { start: new Date('2026-05-01T00:00:00.000Z'), end: new Date('2026-05-07T23:59:59.999Z') },
      provider: 'all',
      project: ['api'],
      exclude: ['client-a'],
    })

    const message = share.projects[0]!.sessions[0]!.turns[0]!.userMessage
    expect(message).toBe('[project:1] failed in [project:1], but rapidapi and apiKey are library names')
    expect(share.filters.project).toEqual(['[project:1]'])
    expect(share.filters.exclude).toEqual(['[project:2]'])
  })

  it('keeps placeholders stable and does not rewrite them as project labels', () => {
    const repeated = redactForShare('token=repeatsecret123 token=repeatsecret123')
    expect((repeated.match(/\[secret:1\]/g) ?? [])).toHaveLength(2)
    expect(repeated).not.toContain('[secret:2]')

    const projects: ProjectSummary[] = [{
      project: 'secret',
      projectPath: '/Users/husam/work/secret',
      totalCostUSD: 0.01,
      totalApiCalls: 1,
      sessions: [{
        sessionId: 'session-1',
        project: 'secret',
        firstTimestamp: '2026-05-05T10:00:00.000Z',
        lastTimestamp: '2026-05-05T10:01:00.000Z',
        totalCostUSD: 0.01,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        apiCalls: 1,
        turns: [{
          userMessage: 'secret uses token=verysecret12345',
          assistantCalls: [],
          timestamp: '2026-05-05T10:00:00.000Z',
          sessionId: 'session-1',
          category: 'debugging',
          retries: 0,
          hasEdits: false,
        }],
        modelBreakdown: {},
        toolBreakdown: {},
        mcpBreakdown: {},
        bashBreakdown: {},
        categoryBreakdown: {},
        skillBreakdown: {},
      }],
    }]

    const share = buildRedactedShare(projects, {
      label: '7 Days',
      range: { start: new Date('2026-05-01T00:00:00.000Z'), end: new Date('2026-05-07T23:59:59.999Z') },
      provider: 'all',
      project: [],
      exclude: [],
    })

    expect(share.projects[0]!.sessions[0]!.turns[0]!.userMessage).toBe('[project:1] uses token=[secret:1]')
  })

  it('writes json output and appends json extension when needed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-share-'))
    try {
      const share = buildRedactedShare([], {
        label: 'Today',
        range: { start: new Date('2026-05-05T00:00:00.000Z'), end: new Date('2026-05-05T23:59:59.999Z') },
        provider: 'all',
        project: [],
        exclude: [],
      })

      const savedPath = await writeRedactedShare(share, join(dir, 'support-bundle'))
      const content = JSON.parse(await readFile(savedPath, 'utf-8'))

      expect(savedPath.endsWith('support-bundle.json')).toBe(true)
      expect(content.schema).toBe('codeburn.share.v1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
