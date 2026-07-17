/**
 * Integration test: codeburn sync push against real AWS infrastructure.
 *
 * Requires:
 * - Deployed CodeburnSyncBackend stack
 * - Environment variables: CODEBURN_SYNC_URL, CODEBURN_SYNC_EMAIL, CODEBURN_SYNC_PASSWORD
 * - AWS credentials (for verifying CloudWatch logs)
 *
 * Run:
 *   CODEBURN_SYNC_URL=https://xxx.execute-api.us-west-2.amazonaws.com \
 *   CODEBURN_SYNC_EMAIL=andklee@amazon.com \
 *   CODEBURN_SYNC_PASSWORD='password' \
 *   AWS_PROFILE=andklee-dev \
 *   npx vitest run tests/sync-infra-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, createHash } from 'crypto'

import { fetchDiscoveryDoc } from '../src/sync/discovery.js'
import { fetchOidcConfig, refreshToken } from '../src/sync/auth.js'
import { buildOtlpPayload, deriveSpanId, type CallWithSession } from '../src/sync/otlp.js'
import type { ParsedApiCall, TokenUsage } from '../src/types.js'

const BASE_URL = process.env.CODEBURN_SYNC_URL
const TEST_EMAIL = process.env.CODEBURN_SYNC_EMAIL
const TEST_PASSWORD = process.env.CODEBURN_SYNC_PASSWORD
const AWS_REGION = process.env.AWS_REGION || 'us-west-2'

const SKIP = !BASE_URL || !TEST_EMAIL || !TEST_PASSWORD

describe.skipIf(SKIP)('sync infra e2e — push + verify', () => {
  let accessToken: string
  let clientId: string
  let tracesEndpoint: string
  const testRunId = randomBytes(4).toString('hex')

  beforeAll(async () => {
    // Get tokens via admin API (Cognito USER_PASSWORD_AUTH)
    const discovery = await fetchDiscoveryDoc(BASE_URL!)
    clientId = discovery.client_id
    tracesEndpoint = `${BASE_URL}${discovery.traces_path}`

    // Direct auth (USER_PASSWORD_AUTH) for testing
    const tokenEndpoint = `https://codeburn-sync.auth.${AWS_REGION}.amazoncognito.com/oauth2/token`

    // Use Cognito initiateAuth via fetch to the Cognito service
    const cognitoUrl = `https://cognito-idp.${AWS_REGION}.amazonaws.com/`
    const userPoolId = discovery.issuer.split('/').pop()!

    const authResp = await fetch(cognitoUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: TEST_EMAIL,
          PASSWORD: TEST_PASSWORD,
        },
      }),
    })

    const authResult = await authResp.json() as { AuthenticationResult?: { AccessToken?: string } }
    accessToken = authResult.AuthenticationResult?.AccessToken ?? ''
    expect(accessToken).toBeTruthy()
  })

  it('pushes a test span and receives 200', async () => {
    const testDedup = `test:infra-e2e:${testRunId}:span1`
    const usage: TokenUsage = {
      inputTokens: 999,
      outputTokens: 111,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    }

    const call: ParsedApiCall = {
      provider: 'test',
      model: 'test-model',
      usage,
      costUSD: 0.001,
      tools: ['TestTool'],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp: new Date().toISOString(),
      bashCommands: [],
      deduplicationKey: testDedup,
    }

    const callWithSession: CallWithSession = {
      call,
      sessionId: `test-session-${testRunId}`,
      project: 'infra-e2e-test',
    }

    const payload = buildOtlpPayload([callWithSession])

    const response = await fetch(tracesEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    // No partial_success means full success
    expect(body.partialSuccess?.rejectedSpans).toBeUndefined()
  })

  it('rejects unauthenticated requests', async () => {
    const payload = buildOtlpPayload([])

    const response = await fetch(tracesEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-token',
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(401)
  })

  it('pushes multiple spans in one batch', async () => {
    const calls: CallWithSession[] = Array.from({ length: 5 }, (_, i) => {
      const usage: TokenUsage = {
        inputTokens: 100 * (i + 1),
        outputTokens: 50 * (i + 1),
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
      }
      return {
        call: {
          provider: 'test',
          model: 'test-batch-model',
          usage,
          costUSD: 0.01 * (i + 1),
          tools: [],
          mcpTools: [],
          skills: [],
          subagentTypes: [],
          hasAgentSpawn: false,
          hasPlanMode: false,
          speed: 'standard' as const,
          timestamp: new Date().toISOString(),
          bashCommands: [],
          deduplicationKey: `test:infra-e2e:${testRunId}:batch:${i}`,
        },
        sessionId: `test-batch-session-${testRunId}`,
        project: 'infra-e2e-batch',
      }
    })

    const payload = buildOtlpPayload(calls)

    const response = await fetch(tracesEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
  })

  it('deterministic span IDs allow safe re-push', async () => {
    const dedup = `test:infra-e2e:${testRunId}:idempotent`
    const spanId = deriveSpanId(dedup)

    // Push same data twice
    const call: CallWithSession = {
      call: {
        provider: 'test',
        model: 'test-idempotent',
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
        costUSD: 0,
        tools: [],
        mcpTools: [],
        skills: [],
        subagentTypes: [],
        hasAgentSpawn: false,
        hasPlanMode: false,
        speed: 'standard',
        timestamp: new Date().toISOString(),
        bashCommands: [],
        deduplicationKey: dedup,
      },
      sessionId: 'idem-session',
      project: 'idem-project',
    }

    const payload = buildOtlpPayload([call])

    // First push
    const r1 = await fetch(tracesEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
    })
    expect(r1.status).toBe(200)

    // Second push (identical payload)
    const r2 = await fetch(tracesEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
    })
    expect(r2.status).toBe(200)

    // Both succeed — server tolerates duplicates per OTLP spec
  })
})
