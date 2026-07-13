/**
 * E2E test: codeburn sync setup with headless browser against real Cognito.
 *
 * This test exercises the FULL PKCE flow:
 * 1. Starts the callback server (simulating `codeburn sync setup`)
 * 2. Builds the auth URL with PKCE challenge
 * 3. Opens a headless Chromium to the Cognito Hosted UI
 * 4. Fills the login form with test credentials
 * 5. Submits → Cognito redirects to localhost callback
 * 6. Callback server receives code + state
 * 7. Exchanges code for tokens
 *
 * Requirements:
 * - Playwright + Chromium installed (`npx playwright install chromium`)
 * - Real Cognito endpoint deployed (CodeburnSyncBackend stack)
 * - Test user created in the pool
 *
 * Run: npx vitest run tests/sync-headless-e2e.test.ts
 * Skip in CI without infra: set SKIP_HEADLESS_E2E=1
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

import { fetchDiscoveryDoc } from '../src/sync/discovery.js'
import {
  fetchOidcConfig,
  generatePkce,
  buildAuthUrl,
  resolveScopes,
  startCallbackServer,
  exchangeCode,
} from '../src/sync/auth.js'
import { randomBytes } from 'crypto'

// --- Configuration (from deployed stack outputs) ---
const BASE_URL = process.env.CODEBURN_SYNC_URL
const TEST_EMAIL = process.env.CODEBURN_SYNC_EMAIL
const TEST_PASSWORD = process.env.CODEBURN_SYNC_PASSWORD

// Only runs when ALL three env vars are set. Developer-only test.
const SKIP = !BASE_URL || !TEST_EMAIL || !TEST_PASSWORD

describe.skipIf(SKIP)('sync setup — headless browser PKCE flow', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('full PKCE flow: callback server → Cognito login → token exchange', async () => {
    // 1. Fetch discovery + OIDC config
    const discovery = await fetchDiscoveryDoc(BASE_URL)
    const oidc = await fetchOidcConfig(discovery.issuer)
    const scopes = resolveScopes(discovery.scopes, oidc.scopes_supported)

    // 2. PKCE + state
    const pkce = generatePkce()
    const state = randomBytes(16).toString('hex')

    // 3. Start callback server
    const { promise: callbackPromise, ready } = startCallbackServer(state, 30000)
    const port = await ready
    const redirectUri = `http://127.0.0.1:${port}/callback`

    // 4. Build auth URL
    const authUrl = buildAuthUrl({
      authorization_endpoint: oidc.authorization_endpoint,
      client_id: discovery.client_id,
      redirect_uri: redirectUri,
      scopes,
      state,
      pkce,
    })

    // 5. Open headless browser to Cognito Hosted UI
    const page: Page = await browser.newPage()

    try {
      await page.goto(authUrl, { waitUntil: 'networkidle' })

      // 6. Fill login form
      // Cognito Hosted UI renders two tabbed forms (Sign In + Sign Up).
      // The inputs exist but may not be CSS-visible. Use JS to fill the
      // sign-in form directly, targeting inputs within the form that has
      // the signInSubmitButton.
      await page.evaluate((creds) => {
        const forms = document.querySelectorAll('form')
        for (const form of forms) {
          if (!form.querySelector('input[name="signInSubmitButton"]')) continue
          const username = form.querySelector('input[name="username"]') as HTMLInputElement
          const password = form.querySelector('input[name="password"]') as HTMLInputElement
          if (username) { username.value = creds.email; username.dispatchEvent(new Event('input', { bubbles: true })) }
          if (password) { password.value = creds.password; password.dispatchEvent(new Event('input', { bubbles: true })) }
        }
      }, { email: TEST_EMAIL, password: TEST_PASSWORD })

      // 7. Submit the form via JS
      await page.evaluate(() => {
        const btn = document.querySelector('input[name="signInSubmitButton"]') as HTMLInputElement
        if (btn) btn.click()
      })

      // 8. Wait for redirect to our callback server
      // Cognito will redirect to http://127.0.0.1:{port}/callback?code=...&state=...
      // The page will load our callback server's "Login successful" response
      await page.waitForURL(`http://127.0.0.1:${port}/callback*`, { timeout: 15000 })

      // 9. Callback server should have received the code
      const result = await callbackPromise
      expect(result.code).toBeTruthy()
      expect(result.code.length).toBeGreaterThan(10)

      // 10. Exchange code for tokens
      const tokens = await exchangeCode(
        oidc.token_endpoint,
        result.code,
        pkce.code_verifier,
        redirectUri,
        discovery.client_id,
      )

      expect(tokens.access_token).toBeTruthy()
      expect(tokens.refresh_token).toBeTruthy()
      expect(tokens.token_type).toBe('Bearer')
      expect(tokens.expires_in).toBeGreaterThan(0)

      console.log('✅ Full PKCE flow completed successfully!')
      console.log(`   Access token: ${tokens.access_token.slice(0, 30)}...`)
      console.log(`   Refresh token: ${tokens.refresh_token!.slice(0, 30)}...`)
      console.log(`   Expires in: ${tokens.expires_in}s`)
    } finally {
      await page.close()
    }
  }, 60000) // 60s timeout for the full browser flow
})
