/// The tray's resolved catalog, cached from Rust.
///
/// Rust owns the catalogs and the `%@` / `%lld` / `%1$@` substitution. This module only
/// remembers the map for the language already chosen and reloads it when settings change.
/// A missing key is the English sentence, which is also the catalog key.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'

type Catalog = Record<string, string>

let catalog: Catalog = {}
let listeners: Array<() => void> = []
let unlisten: (() => void) | null = null
let reloadGeneration = 0

function publish() {
  for (const listener of listeners) listener()
}

async function reload() {
  const generation = ++reloadGeneration
  try {
    const next = await invoke<Catalog>('i18n_catalog')
    if (generation !== reloadGeneration) return
    catalog = next ?? {}
  } catch {
    if (generation !== reloadGeneration) return
    catalog = {}
  }
  publish()
}

/// Subscribes to catalog reloads. The first subscriber starts the settings listener.
export function subscribeI18n(listener: () => void): () => void {
  listeners.push(listener)
  if (listeners.length === 1) {
    void reload()
    void listen('codeburn://settings-changed', () => {
      void reload()
    }).then(fn => { unlisten = fn })
  }
  return () => {
    listeners = listeners.filter(item => item !== listener)
    if (listeners.length === 0 && unlisten) {
      unlisten()
      unlisten = null
    }
  }
}

/// The translated sentence, or `key` itself when this language has no entry.
export function t(key: string): string {
  return catalog[key] ?? key
}

/// Fills a glossary format string in Rust. Arguments stay in the order the placeholders name.
export function formatMessage(key: string, args: Array<string | number>): Promise<string> {
  return invoke<string>('i18n_format', { key, args })
}

/// Bumps when the catalog is replaced, so a sentence read through `t` renders again.
export function useI18nRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeI18n(() => setRevision(value => value + 1)), [])
  return revision
}
