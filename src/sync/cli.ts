/**
 * codeburn sync — CLI commands.
 *
 * Registers: sync setup | push | status | logout | reset
 */

import type { Command } from 'commander'
import { randomBytes } from 'crypto'

import { fetchDiscoveryDoc } from './discovery.js'
import {
  fetchOidcConfig,
  generatePkce,
  buildAuthUrl,
  resolveScopes,
  startCallbackServer,
  exchangeCode,
  refreshToken,
  revokeToken,
  CALLBACK_PORTS,
} from './auth.js'
import { createCredentialStore } from './credentials.js'
import { readSyncConfig, writeSyncConfig, deleteSyncConfig, updateLastSync } from './config.js'
import { collectUnsentCalls, sendBatches, batchCalls, MAX_PER_PUSH } from './push.js'

export function registerSyncCommands(program: Command): void {
  const sync = program
    .command('sync')
    .description('Sync AI usage telemetry to a remote OTLP endpoint')

  // --- setup ---
  sync
    .command('setup <url>')
    .description('Configure sync with a remote endpoint (one-time)')
    .action(async (url: string) => {
      const baseUrl = url.replace(/\/$/, '')
      process.stderr.write(`Fetching discovery doc from ${baseUrl}...\n`)

      // 1. Fetch codeburn discovery doc
      const discovery = await fetchDiscoveryDoc(baseUrl)
      process.stderr.write(`  Issuer: ${discovery.issuer}\n`)
      process.stderr.write(`  Client: ${discovery.client_id}\n`)

      // 2. Fetch OIDC configuration from the issuer
      const oidc = await fetchOidcConfig(discovery.issuer)
      process.stderr.write(`  Auth endpoint: ${oidc.authorization_endpoint}\n`)

      // 3. Resolve scopes
      const scopes = resolveScopes(discovery.scopes, oidc.scopes_supported)

      // 4. Generate PKCE
      const pkce = generatePkce()
      const state = randomBytes(16).toString('hex')

      // 5. Start callback server — await the actually-bound port (port
      // fallback means it may not be the first in CALLBACK_PORTS)
      const { promise: callbackPromise, ready } = startCallbackServer(state)
      const port = await ready
      const redirectUri = `http://127.0.0.1:${port}/callback`

      // 6. Build auth URL and open browser
      const authUrl = buildAuthUrl({
        authorization_endpoint: oidc.authorization_endpoint,
        client_id: discovery.client_id,
        redirect_uri: redirectUri,
        scopes,
        state,
        pkce,
      })

      process.stderr.write(`\nOpening browser for login...\n`)
      process.stderr.write(`If the browser doesn't open, visit:\n  ${authUrl}\n\n`)

      // Open browser (best-effort, platform-specific).
      // execFileSync with args array — authUrl comes from the remote discovery
      // doc so it must never be shell-interpolated. Scheme is also validated.
      try {
        if (!/^https:\/\//.test(authUrl)) {
          throw new Error('auth URL must be https')
        }
        const { execFileSync } = await import('child_process')
        if (process.platform === 'darwin') {
          execFileSync('open', [authUrl], { stdio: 'ignore' })
        } else if (process.platform === 'win32') {
          // `start` is a cmd builtin; empty first arg is the window title
          execFileSync('cmd', ['/c', 'start', '', authUrl], { stdio: 'ignore' })
        } else {
          execFileSync('xdg-open', [authUrl], { stdio: 'ignore' })
        }
      } catch {
        // Browser open failed — user sees the URL above
      }

      // 7. Wait for callback
      process.stderr.write(`Waiting for login (5 min timeout)...\n`)
      const callback = await callbackPromise

      // 8. Exchange code for tokens
      const tokenRedirectUri = `http://127.0.0.1:${callback.port}/callback`
      const tokens = await exchangeCode(
        oidc.token_endpoint,
        callback.code,
        pkce.code_verifier,
        tokenRedirectUri,
        discovery.client_id,
      )

      if (!tokens.refresh_token) {
        process.stderr.write(`Warning: IdP did not return a refresh token. You may need to re-authenticate frequently.\n`)
      }

      // 9. Store credentials
      const store = createCredentialStore()
      if (tokens.refresh_token) {
        store.store(tokens.refresh_token)
      }

      // 10. Write config
      writeSyncConfig({
        baseUrl,
        clientId: discovery.client_id,
        tracesPath: discovery.traces_path,
        issuer: discovery.issuer,
      })

      process.stderr.write(`\n✓ Sync configured successfully.\n`)
      process.stderr.write(`  Endpoint: ${baseUrl}\n`)
      process.stderr.write(`  Token stored in: ${store.method()}\n`)
      process.stderr.write(`\nRun \`codeburn sync push\` to send telemetry data.\n`)
    })

  // --- status ---
  sync
    .command('status')
    .description('Show sync configuration and auth status')
    .action(async () => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }

      const store = createCredentialStore()
      const token = store.retrieve()

      process.stdout.write(`Endpoint: ${config.baseUrl}\n`)
      process.stdout.write(`Traces path: ${config.tracesPath}\n`)
      process.stdout.write(`Issuer: ${config.issuer}\n`)
      process.stdout.write(`Auth: ${token ? 'configured' : 'missing (run sync setup)'}\n`)
      process.stdout.write(`Token storage: ${store.method()}\n`)
      process.stdout.write(`Last sync: ${config.lastSync ?? 'never'}\n`)
    })

  // --- logout ---
  sync
    .command('logout')
    .description('Remove stored credentials and revoke token')
    .action(async () => {
      const config = readSyncConfig()
      const store = createCredentialStore()
      const token = store.retrieve()

      // Revoke if we have a token and know the revocation endpoint
      if (token && config) {
        try {
          const oidc = await fetchOidcConfig(config.issuer)
          if (oidc.revocation_endpoint) {
            await revokeToken(oidc.revocation_endpoint, token, config.clientId)
            process.stderr.write('Token revoked at IdP.\n')
          }
        } catch {
          // Best-effort revocation
        }
      }

      store.delete()
      deleteSyncConfig()
      process.stderr.write('Sync credentials and config removed.\n')
    })

  // --- reset ---
  sync
    .command('reset')
    .description('Clear the sent-ledger (next push re-sends all calls in window)')
    .option('--confirm', 'Required to confirm reset')
    .action(async (opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        process.stderr.write('This will clear the sent-ledger, causing the next push to re-send all data.\n')
        process.stderr.write('Run with --confirm to proceed.\n')
        process.exit(1)
      }

      const { clearLedger } = await import('./ledger.js')
      const removed = clearLedger()
      if (removed > 0) {
        process.stderr.write(`Ledger cleared (${removed} entries). Next push will re-send all calls in window.\n`)
      } else {
        process.stderr.write('No ledger entries found (nothing to reset).\n')
      }
    })

  // --- push (placeholder for Step 2) ---
  sync
    .command('push')
    .description('Push unsent telemetry data to the configured endpoint')
    .option('--since <period>', 'Time window: today, 7d, 30d, month, all (max 6 months)', '7d')
    .option('--dry-run', 'Show what would be sent without sending')
    .action(async (opts: { since: string; dryRun?: boolean }) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }

      const store = createCredentialStore()
      const rt = store.retrieve()
      if (!rt) {
        process.stderr.write('No auth token found. Run `codeburn sync setup` to authenticate.\n')
        process.exit(1)
      }

      // Refresh token
      try {
        const oidc = await fetchOidcConfig(config.issuer)
        const tokens = await refreshToken(oidc.token_endpoint, rt, config.clientId)

        // Store rotated token if present
        if (tokens.refresh_token && tokens.refresh_token !== rt) {
          store.store(tokens.refresh_token)
        }

        if (opts.dryRun) {
          process.stderr.write(`[dry-run] Auth: valid (Bearer token obtained)\n`)
        }

        // Collect data
        const { parseAllSessions } = await import('../parser.js')
        const { getDateRange } = await import('../cli-date.js')

        // Map --since to a parser period. Strict: unknown values are an error.
        const sinceToPeriod: Record<string, string> = {
          'today': 'today',
          '7d': 'week', 'week': 'week',
          '30d': '30days', '30days': '30days',
          'month': 'month',
          'all': 'all', // up to 6 months (parser retention limit)
        }
        const period = sinceToPeriod[opts.since]
        if (!period) {
          process.stderr.write(`Unknown --since value "${opts.since}". Valid: today, 7d, 30d, month, all.\n`)
          process.exit(1)
        }
        const { range } = getDateRange(period)
        const projects = await parseAllSessions(range)

        // Flatten + filter against sent-ledger
        const { allCalls, unsent } = collectUnsentCalls(projects)

        if (opts.dryRun) {
          const toPushCount = Math.min(unsent.length, MAX_PER_PUSH)
          const cost = unsent.slice(0, MAX_PER_PUSH).reduce((s, c) => s + c.call.costUSD, 0)
          process.stderr.write(`[dry-run] Window: ${opts.since} — ${allCalls.length} calls total, ${allCalls.length - unsent.length} already synced\n`)
          process.stderr.write(`[dry-run] Would push ${toPushCount} calls ($${cost.toFixed(2)}) to ${config.baseUrl}${config.tracesPath}\n`)
          if (unsent.length > MAX_PER_PUSH) {
            process.stderr.write(`[dry-run] ${unsent.length - MAX_PER_PUSH} more calls exceed the ${MAX_PER_PUSH} safety limit — a second push would be needed\n`)
          }
          return
        }

        if (unsent.length === 0) {
          process.stderr.write(`Nothing to push (${allCalls.length} calls already synced).\n`)
          updateLastSync()
          return
        }

        // Safety valve (not a routine cap — pushes run to completion)
        const toPush = unsent.slice(0, MAX_PER_PUSH)
        if (unsent.length > MAX_PER_PUSH) {
          process.stderr.write(`${unsent.length} unsent calls exceed the ${MAX_PER_PUSH} safety limit. Pushing first ${MAX_PER_PUSH}; run again to continue.\n`)
        }

        // Batch and send (loops until done; waits out 429 rate limits)
        const discoveryDoc = await fetchDiscoveryDoc(config.baseUrl)
        const batches = batchCalls(toPush, discoveryDoc.max_batch_size)
        const endpoint = `${config.baseUrl}${config.tracesPath}`

        const result = await sendBatches({
          endpoint,
          accessToken: tokens.access_token,
          batches,
          log: msg => process.stderr.write(`${msg}\n`),
        })

        if (result.outcome === 'auth-rejected') {
          process.stderr.write('Auth rejected by server. Run `codeburn sync setup` to re-authenticate.\n')
          process.exit(1)
        }
        if (result.outcome === 'rate-limited') {
          process.stderr.write(`Rate limited — gave up after repeated retries. Remaining calls will be sent on the next push.\n`)
        }
        if (result.outcome === 'server-error') {
          process.stderr.write(`Server error (HTTP ${result.httpStatus}). Remaining calls will be sent on the next push.\n`)
        }

        // Update lastSync
        updateLastSync()

        // Summary
        process.stderr.write(`\nSynced ${result.totalSent} calls ($${result.totalCostSent.toFixed(2)}) to ${config.baseUrl}\n`)
        if (result.totalRejected > 0) {
          process.stderr.write(`  ${result.totalRejected} spans rejected (will retry on next push)\n`)
        }
        if (unsent.length > MAX_PER_PUSH) {
          process.stderr.write(`  ${unsent.length - MAX_PER_PUSH} calls remaining (safety limit). Run \`codeburn sync push\` again.\n`)
        }

        // Non-zero exit when the push did not complete, so cron/scripts can
        // detect it. Ledgered progress is kept; next push resumes.
        if (result.outcome !== 'complete') {
          process.exitCode = 1
        }
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exit(1)
      }
    })
}
