import React, { useEffect, useState } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'

import { formatTokens } from './format.js'
import { patchStdoutForWindows } from './ink-win.js'
import {
  buildContextTree,
  listRecentTitledSessions,
  relativeAge,
  snapshotRows,
  type ContextTreeResult,
  type TitledSessionRef,
} from './context-tree.js'
import { buildCodexContextTree, listRecentCodexSessions } from './context-tree-codex.js'

type Provider = 'claude' | 'codex'
type Scope = 'effective' | 'full'

const ORANGE = '#FF8C42'
const DIM = '#555555'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PROVIDERS: Array<{ key: Provider; label: string }> = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
]

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

async function loadSessions(provider: Provider): Promise<TitledSessionRef[]> {
  return provider === 'codex' ? listRecentCodexSessions(15) : listRecentTitledSessions(15)
}

function TreeDetails({ tree, scope }: { tree: ContextTreeResult; scope: Scope }) {
  const view = scope === 'full' ? tree.full : tree.effective
  const rows = snapshotRows(view)
  const labelWidth = Math.max(...rows.map((r) => r.depth * 2 + r.label.length)) + 2
  const countWidth = Math.max(...rows.map((r) => `${r.count}x`.length)) + 1
  const tokenWidth = Math.max(...rows.map((r) => formatTokens(r.tokens).length)) + 2

  const headline: string[] = [`model ${tree.model}`, `messages ${view.messages.toLocaleString('en-US')}`, `est ${formatTokens(view.tokens)}`]
  if (tree.reported) {
    const { context, window } = tree.reported
    headline.push(window ? `context ${formatTokens(context)} / ${formatTokens(window)} (${Math.round((context / window) * 100)}%)` : `context ${formatTokens(context)} (exact)`)
  }
  if (tree.compactions > 0) headline.push(`${tree.compactions} compaction${tree.compactions === 1 ? '' : 's'}`)

  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1} paddingLeft={1} borderStyle="round" borderColor={DIM} width={72}>
      <Text color={DIM}>
        {headline.join(' · ')}
      </Text>
      <Text color={DIM}>
        showing <Text color={ORANGE}>{scope === 'effective' ? 'live window' : 'full history'}</Text> · press f to switch
      </Text>
      <Box height={1} />
      {rows.map((r, i) => (
        <Text key={i}>
          {' '.repeat(r.depth * 2)}
          <Text bold={r.bold} color={r.bold ? undefined : DIM}>
            {(r.label + ' ').padEnd(labelWidth - r.depth * 2, r.bold ? ' ' : '·')}
          </Text>
          <Text color={DIM}>{`${r.count.toLocaleString('en-US')}x`.padStart(countWidth)}</Text>
          <Text color={ORANGE} bold={r.bold}>
            {formatTokens(r.tokens).padStart(tokenWidth)}
          </Text>
        </Text>
      ))}
    </Box>
  )
}

function ContextTuiApp({ initialScope }: { initialScope: Scope }) {
  const { exit } = useApp()
  const [provider, setProvider] = useState<Provider>('claude')
  const [sessions, setSessions] = useState<TitledSessionRef[] | null>(null)
  const [cursor, setCursor] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>(initialScope)
  const [building, setBuilding] = useState(false)
  const [frame, setFrame] = useState(0)
  const [trees, setTrees] = useState<Record<string, ContextTreeResult>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    setSessions(null)
    setCursor(0)
    setExpandedId(null)
    void loadSessions(provider).then((rows) => {
      if (alive) setSessions(rows)
    })
    return () => {
      alive = false
    }
  }, [provider])

  useEffect(() => {
    if (!building) return
    const t = setInterval(() => setFrame((f) => f + 1), 100)
    return () => clearInterval(t)
  }, [building])

  const toggleExpand = (session: TitledSessionRef) => {
    if (expandedId === session.sessionId) {
      setExpandedId(null)
      return
    }
    setExpandedId(session.sessionId)
    const key = `${provider}:${session.sessionId}:${session.mtimeMs}`
    if (trees[key]) return
    setBuilding(true)
    setErrors((e) => ({ ...e, [key]: '' }))
    const build = provider === 'claude' ? buildContextTree(session) : buildCodexContextTree(session)
    void build
      .then((tree) => setTrees((t) => ({ ...t, [key]: tree })))
      .catch((err: unknown) => setErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) })))
      .finally(() => setBuilding(false))
  }

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit()
      return
    }
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow || input === 'j') setCursor((c) => Math.min((sessions?.length ?? 1) - 1, c + 1))
    if (key.tab || key.leftArrow || key.rightArrow) setProvider((p) => (p === 'claude' ? 'codex' : 'claude'))
    if (input === 'f') setScope((s) => (s === 'effective' ? 'full' : 'effective'))
    if ((key.return || input === ' ') && sessions && sessions[cursor]) toggleExpand(sessions[cursor])
  })

  const titleWidth = 46

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text bold color={ORANGE}>
          Context{' '}
        </Text>
        {PROVIDERS.map((p) => (
          <Text key={p.key}>
            {'  '}
            <Text bold={provider === p.key} color={provider === p.key ? undefined : DIM} inverse={provider === p.key}>
              {` ${p.label} `}
            </Text>
          </Text>
        ))}
        <Text color={DIM}>{'   ↑↓ move · enter expand · tab provider · f scope · q quit'}</Text>
      </Box>
      <Box height={1} />

      {!sessions && <Text color={DIM}>Loading sessions…</Text>}
      {sessions && sessions.length === 0 && <Text color={DIM}>No sessions found for this provider.</Text>}

      {sessions?.map((s, i) => {
        const selected = i === cursor
        const expanded = expandedId === s.sessionId
        const key = `${provider}:${s.sessionId}:${s.mtimeMs}`
        const tree = trees[key]
        const error = errors[key]
        return (
          <Box key={s.filePath} flexDirection="column">
            <Text>
              <Text color={ORANGE}>{selected ? '❯ ' : '  '}</Text>
              <Text color={selected ? ORANGE : undefined}>{s.sessionId.slice(0, 8)}</Text>
              <Text color={expanded || selected ? undefined : DIM}>
                {'  '}
                {truncate(s.title || 'untitled session', titleWidth).padEnd(titleWidth)}
              </Text>
              <Text color={DIM}>
                {'  '}
                {truncate(s.project, 12).padEnd(12)} {relativeAge(s.mtimeMs).padStart(8)} {`${(s.sizeBytes / 1024 / 1024).toFixed(1)}MB`.padStart(8)}
              </Text>
            </Text>
            {expanded && error && (
              <Box marginLeft={4} marginBottom={1}>
                <Text color="red">could not read this session: {error}</Text>
              </Box>
            )}
            {expanded && !tree && !error && (
              <Box marginLeft={4} marginBottom={1}>
                <Text color={ORANGE}>{SPINNER[frame % SPINNER.length]} </Text>
                <Text color={DIM}>reading transcript ({(s.sizeBytes / 1024 / 1024).toFixed(0)}MB)…</Text>
              </Box>
            )}
            {expanded && tree && <TreeDetails tree={tree} scope={scope} />}
          </Box>
        )
      })}

      <Box height={1} />
      <Text color={DIM}>block tokens are estimates; context (exact) comes from API usage</Text>
    </Box>
  )
}

export async function runContextTui(opts: { initialScope?: Scope } = {}): Promise<void> {
  patchStdoutForWindows()
  const instance = render(<ContextTuiApp initialScope={opts.initialScope ?? 'effective'} />)
  await instance.waitUntilExit()
}
