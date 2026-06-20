import { networkInterfaces } from 'os'

import { loadOrCreateIdentity } from './identity.js'
import { PeerStore } from './pairing.js'
import { ShareServer, type UsageQuery } from './share-server.js'
import { getSharingDir, loadPeers, savePeers } from './store.js'
import { loadPricing } from '../models.js'
import { buildMenubarPayloadForRange } from '../usage-aggregator.js'
import { getDateRange, parseDateRangeFlags, formatDateRangeLabel, toPeriod } from '../cli-date.js'

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

const IDLE_TIMEOUT_MS = 10 * 60_000

// Run the secure share server. On-demand by default: it stops after 10 minutes
// of no requests. `--always` keeps it up until Ctrl+C (the opt-in persistent
// mode). `--pair` opens a one-time pairing window and prints the PIN + command.
export async function runShareServer(opts: { port: number; pair: boolean; always: boolean }): Promise<void> {
  await loadPricing()
  const dir = getSharingDir()
  const identity = await loadOrCreateIdentity(dir)
  const peers = new PeerStore(await loadPeers(dir))

  const getUsage = async (q: UsageQuery): Promise<unknown> => {
    const customRange = parseDateRangeFlags(q.from, q.to)
    const periodInfo = customRange
      ? { range: customRange, label: formatDateRangeLabel(q.from, q.to) }
      : getDateRange(toPeriod(q.period ?? 'month'))
    return buildMenubarPayloadForRange(periodInfo, { provider: 'all', optimize: false })
  }

  const server = new ShareServer({
    identity,
    peers,
    getUsage,
    onPaired: () => {
      void savePeers(peers.list(), dir)
    },
  })

  const port = await server.listen(opts.port, '0.0.0.0')
  const ip = lanAddress() ?? '127.0.0.1'

  process.stdout.write(`\n  Sharing "${identity.name}" at ${ip}:${port}\n`)
  process.stdout.write(`  Fingerprint ${identity.fingerprint.slice(0, 16)}...\n`)

  if (opts.pair) {
    const pin = server.openPairing(120_000)
    process.stdout.write(`\n  Pairing open for 2 minutes. On the other device, run:\n`)
    process.stdout.write(`    codeburn devices add ${ip}:${port} --pin ${pin}\n`)
  } else if (peers.list().length === 0) {
    process.stdout.write(`\n  No paired devices yet. Re-run with --pair to add one.\n`)
  }

  process.stdout.write(`\n  ${peers.list().length} paired device(s). Press Ctrl+C to stop.\n\n`)

  if (!opts.always) {
    let last = Date.now()
    server.server.on('request', () => {
      last = Date.now()
    })
    const timer = setInterval(() => {
      if (Date.now() - last > IDLE_TIMEOUT_MS) {
        process.stdout.write('\n  Idle, stopping share. Run `codeburn share` again when you need it.\n')
        process.exit(0)
      }
    }, 30_000)
    timer.unref()
  }

  await new Promise<never>(() => {
    /* run until interrupted */
  })
}
