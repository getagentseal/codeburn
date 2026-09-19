import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MENUBAR_QUOTA_PROVIDERS } from './menubarProviders'

const CATALOG = fileURLToPath(new URL('../../../mac/Sources/CodeBurnMenubar/Data/ProviderConnectionCatalog.swift', import.meta.url))

/** `entry("kimi", "Kimi Code", [...], [...], live: true)`, possibly wrapped across two lines. */
function liveProviders(): Array<{ id: string; name: string }> {
  const source = readFileSync(CATALOG, 'utf8')
  const list = source.slice(source.indexOf('static let providers'))
  const out: Array<{ id: string; name: string }> = []
  for (const call of list.split('entry(').slice(1)) {
    const head = call.match(/^\s*"([^"]+)",\s*"([^"]+)"/)
    if (!head) continue
    const body = call.slice(0, call.indexOf('\n        entry') + 1 || undefined)
    if (/live:\s*true/.test(body.split('\n').slice(0, 3).join('\n'))) out.push({ id: head[1], name: head[2] })
  }
  return out
}

describe('the menu bar provider list', () => {
  it('is the catalog the menubar itself ships, name for name and in its order', () => {
    const live = liveProviders()
    // A guard on the guard: a parse that silently found nothing would make the test vacuous.
    expect(live.length).toBeGreaterThan(5)
    expect(live.map(p => p.name)).toEqual([...MENUBAR_QUOTA_PROVIDERS])
  })
})
