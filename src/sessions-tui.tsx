import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink'

import { formatTokens } from './format.js'
import { patchStdoutForWindows } from './ink-win.js'
import {
  cleanSessionProjectLabel,
  sessionDisplayName,
  sessionModelLabel,
  shortSessionId,
  type SessionRow,
} from './sessions-report.js'

const ORANGE = '#FF8C42'
const MUTED = '#71717A'
const BORDER = '#3F3F46'

type Column = {
  key: 'started' | 'session' | 'project' | 'provider' | 'models' | 'cost' | 'calls' | 'turns'
  label: string
  width: number
  right?: boolean
}

function truncate(value: string, width: number): string {
  if (width <= 0) return ''
  if (value.length <= width) return value
  return width === 1 ? '…' : `${value.slice(0, width - 1)}…`
}

function pad(value: string, width: number, right = false): string {
  const text = truncate(value, width)
  return right ? text.padStart(width) : text.padEnd(width)
}

function startedLabel(value: string): string {
  return value ? value.replace('T', ' ').slice(0, 16) : '—'
}

function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<1m'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

function columnsFor(width: number): Column[] {
  const usable = Math.max(58, width - 4)
  const fixed: Column[] = [
    { key: 'started', label: 'STARTED', width: 16 },
    { key: 'session', label: 'SESSION', width: 26 },
    { key: 'project', label: 'PROJECT', width: 20 },
    { key: 'provider', label: 'PROVIDER', width: 9 },
    { key: 'models', label: 'MODELS', width: 24 },
    { key: 'cost', label: 'COST', width: 9, right: true },
    { key: 'calls', label: 'CALLS', width: 7, right: true },
    { key: 'turns', label: 'TURNS', width: 7, right: true },
  ]

  const keep = width >= 150
    ? fixed
    : width >= 115
      ? fixed.filter(column => column.key !== 'turns' && column.key !== 'calls')
      : width >= 88
        ? fixed.filter(column => !['provider', 'calls', 'turns'].includes(column.key))
        : fixed.filter(column => ['started', 'session', 'project', 'cost'].includes(column.key))

  const gaps = (keep.length - 1) * 2
  const current = keep.reduce((sum, column) => sum + column.width, 0) + gaps
  const flexible = keep.filter(column => ['session', 'project', 'models'].includes(column.key))
  let remaining = usable - current
  const result = keep.map(column => ({ ...column }))

  while (remaining > 0 && flexible.length > 0) {
    for (const column of flexible) {
      if (remaining <= 0) break
      const target = result.find(candidate => candidate.key === column.key)!
      const cap = column.key === 'session' ? 36 : column.key === 'project' ? 30 : 32
      if (target.width < cap) {
        target.width++
        remaining--
      }
    }
    if (flexible.every(column => result.find(candidate => candidate.key === column.key)!.width >= (column.key === 'session' ? 36 : column.key === 'project' ? 30 : 32))) break
  }

  while (remaining < 0) {
    const target = [...result]
      .filter(column => ['session', 'project', 'models'].includes(column.key) && column.width > 12)
      .sort((a, b) => b.width - a.width)[0]
    if (!target) break
    target.width--
    remaining++
  }
  return result
}

function rowValue(row: SessionRow, key: Column['key']): string {
  switch (key) {
    case 'started': return startedLabel(row.startedAt)
    case 'session': return sessionDisplayName(row)
    case 'project': return cleanSessionProjectLabel(row.project)
    case 'provider': return row.provider
    case 'models': return sessionModelLabel(row.models)
    case 'cost': return `$${row.cost.toFixed(2)}`
    case 'calls': return row.calls.toLocaleString('en-US')
    case 'turns': return row.turns.toLocaleString('en-US')
  }
}

function tableLine(row: SessionRow, columns: Column[]): string {
  return columns.map(column => pad(rowValue(row, column.key), column.width, column.right)).join('  ')
}

function headerLine(columns: Column[]): string {
  return columns.map(column => pad(column.label, column.width, column.right)).join('  ')
}

function searchText(row: SessionRow): string {
  return [row.sessionId, row.title, row.project, cleanSessionProjectLabel(row.project), row.provider, ...row.models, sessionModelLabel(row.models)]
    .join(' ')
    .toLowerCase()
}

function DetailPanel({ row, width }: { row: SessionRow; width: number }) {
  const compact = width < 100
  const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
  const context = `${shortSessionId(row.sessionId)}  ·  ${cleanSessionProjectLabel(row.project)}  ·  ${row.provider}  ·  ${sessionModelLabel(row.models)}`
  const metrics = `${row.calls.toLocaleString('en-US')} calls   ${row.turns.toLocaleString('en-US')} turns   ${durationLabel(row.durationMs)}${compact ? '' : `   ${formatTokens(tokens)} tokens   ${startedLabel(row.startedAt)}`}`
  return (
    <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="column" width={Math.max(58, width - 2)}>
      <Text bold>{truncate(sessionDisplayName(row), Math.max(30, width - 8))}</Text>
      <Text color={MUTED}>{truncate(context, Math.max(30, width - 8))}</Text>
      <Text>
        <Text color={ORANGE} bold>${row.cost.toFixed(2)}</Text>
        <Text color={MUTED}>{truncate(`  cost   ${metrics}`, Math.max(24, width - 18))}</Text>
      </Text>
    </Box>
  )
}

function SessionsTui({ rows, period, initialProvider }: { rows: SessionRow[]; period: string; initialProvider: string }) {
  const { exit } = useApp()
  const { columns: terminalWidth, rows: terminalHeight } = useWindowSize()
  const width = Math.max(60, terminalWidth)
  const [cursor, setCursor] = useState(0)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [provider, setProvider] = useState(initialProvider)
  const [showDetails, setShowDetails] = useState(true)

  const providers = useMemo(() => ['all', ...new Set(rows.map(row => row.provider).filter(Boolean))], [rows])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...rows]
      .filter(row => (provider === 'all' || row.provider === provider) && (!needle || searchText(row).includes(needle)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }, [rows, provider, query])

  useEffect(() => {
    setCursor(current => Math.min(current, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  const selected = filtered[cursor]
  const detailLines = showDetails && selected ? 5 : 0
  const pageSize = Math.max(4, terminalHeight - 10 - detailLines)
  const first = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), filtered.length - pageSize))
  const visible = filtered.slice(first, first + pageSize)
  const tableColumns = columnsFor(width)
  const totalCost = filtered.reduce((sum, row) => sum + row.cost, 0)
  const help = width < 92
    ? '↑↓ move  ·  / search  ·  p provider  ·  enter details  ·  q quit'
    : '↑↓/jk move  ·  pgup/pgdn jump  ·  / search  ·  p provider  ·  enter details  ·  q quit'

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearching(false)
        setQuery('')
      } else if (key.return) {
        setSearching(false)
      } else if (key.backspace || key.delete) {
        setQuery(value => value.slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setQuery(value => value + input.replace(/[\r\n]/g, ''))
      }
      return
    }

    if (input === 'q' || key.escape) return exit()
    if (input === '/') {
      setSearching(true)
      return
    }
    if (key.upArrow || input === 'k') setCursor(value => Math.max(0, value - 1))
    if (key.downArrow || input === 'j') setCursor(value => Math.max(0, Math.min(filtered.length - 1, value + 1)))
    if (key.pageUp) setCursor(value => Math.max(0, value - pageSize))
    if (key.pageDown) setCursor(value => Math.max(0, Math.min(filtered.length - 1, value + pageSize)))
    if (key.home || input === 'g') setCursor(0)
    if (key.end || input === 'G') setCursor(Math.max(0, filtered.length - 1))
    if (key.return || input === ' ') setShowDetails(value => !value)
    if (input === 'p' || key.tab) {
      setProvider(value => providers[(providers.indexOf(value) + 1) % providers.length] ?? 'all')
      setCursor(0)
    }
    if (input === 'c') {
      setQuery('')
      setCursor(0)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} width={width}>
      <Box justifyContent="space-between">
        <Text><Text color={ORANGE}>●</Text>  <Text bold>Sessions</Text>  <Text color={MUTED}>{period}</Text></Text>
        <Text color={MUTED}>{filtered.length.toLocaleString('en-US')} sessions  ·  <Text color="white" bold>${totalCost.toFixed(2)}</Text> total</Text>
      </Box>
      <Box marginTop={1} marginBottom={1}>
        <Text color={MUTED}>Provider </Text>
        <Text backgroundColor="#27272A" bold> {provider === 'all' ? 'All providers' : provider} </Text>
        <Text color={MUTED}>   Search </Text>
        <Text color={query || searching ? 'white' : MUTED}>{searching ? `/${query}▌` : query || 'press /'}</Text>
        {query && !searching ? <Text color={MUTED}>  ·  c clear</Text> : null}
      </Box>

      <Text color={MUTED} bold>{`  ${headerLine(tableColumns)}`}</Text>
      <Text color={BORDER}>{'─'.repeat(Math.min(width - 2, headerLine(tableColumns).length + 2))}</Text>
      {visible.map((row, index) => {
        const absoluteIndex = first + index
        const active = absoluteIndex === cursor
        return (
          <Text key={`${row.provider}:${row.sessionId}:${row.startedAt}`} backgroundColor={active ? '#27272A' : undefined} color={active ? 'white' : undefined} bold={active}>
            <Text color={active ? ORANGE : MUTED}>{active ? '› ' : '  '}</Text>{tableLine(row, tableColumns)}
          </Text>
        )
      })}
      {filtered.length === 0 ? <Text color={MUTED}>  No sessions match this filter.</Text> : null}

      <Box marginTop={1}>
        {selected && showDetails ? <DetailPanel row={selected} width={width} /> : null}
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text color={MUTED}>{help}</Text>
        <Text color={MUTED}>{filtered.length ? `${cursor + 1} / ${filtered.length}` : ''}</Text>
      </Box>
    </Box>
  )
}

export async function runSessionsTui(rows: SessionRow[], opts: { period: string; provider: string }): Promise<void> {
  patchStdoutForWindows()
  const instance = render(<SessionsTui rows={rows} period={opts.period} initialProvider={opts.provider} />)
  await instance.waitUntilExit()
}
