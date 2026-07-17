import { Bonjour, type Service } from 'bonjour-service'

const SERVICE_TYPE = 'codeburn'

export type DiscoveredDevice = { name: string; host: string; port: number; fingerprint: string }

export type Advertiser = { stop: () => Promise<void> }

// Announce this device on the local network so others can find it without an IP.
export function advertise(opts: { name: string; port: number; fingerprint: string }): Advertiser {
  const bonjour = new Bonjour()
  bonjour.publish({
    name: opts.name,
    type: SERVICE_TYPE,
    port: opts.port,
    txt: { fp: opts.fingerprint, dn: opts.name, v: '1' },
  })
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        bonjour.unpublishAll(() => bonjour.destroy(() => resolve()))
      }),
  }
}

function pickAddress(service: Service): string | null {
  const addrs = service.addresses ?? []
  const ipv4 = addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
  if (ipv4) return ipv4
  if (service.host) return service.host
  return addrs[0] ?? null
}

// Browse the local network for sharing devices for `timeoutMs`. Resolves to the
// devices found, deduped by fingerprint.
export function browse(timeoutMs = 2500): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>()
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let browser: { stop: () => void } | null = null
    let bonjour: Bonjour | null = null

    const finish = (devices: DiscoveredDevice[]) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      browser?.stop()
      if (!bonjour) {
        resolve(devices)
        return
      }
      try {
        bonjour.destroy(() => resolve(devices))
      } catch {
        resolve(devices)
      }
    }

    const finishWithError = (err?: unknown) => {
      if (err) console.error(`codeburn devices scan: mDNS discovery failed: ${err instanceof Error ? err.message : String(err)}`)
      else console.error('codeburn devices scan: mDNS discovery failed')
      finish([...found.values()])
    }

    bonjour = new Bonjour({}, finishWithError)
    const mdns = (bonjour as unknown as { server?: { mdns?: { on: (event: string, cb: () => void) => void } } }).server?.mdns
    mdns?.on('error', finishWithError)
    browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
      const txt = (service.txt ?? {}) as Record<string, string>
      const fingerprint = txt['fp']
      const address = pickAddress(service)
      if (!fingerprint || !address) return
      const name = txt['dn'] || service.name || address
      found.set(fingerprint, { name, host: address, port: service.port, fingerprint })
    })
    timer = setTimeout(() => finish([...found.values()]), timeoutMs)
    timer.unref?.()
  })
}
