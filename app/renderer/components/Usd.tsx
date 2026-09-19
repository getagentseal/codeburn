import { useId, useRef, useState, type ReactElement, type RefObject } from 'react'
import { AnchoredSurface } from './AnchoredSurface'
import { useEscape } from '../hooks/useEscape'
import { formatCompact, formatUsd } from '../lib/format'

/** The token counts behind one dollar amount. `calls` is optional context. */
export type TokenBreakdown = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls?: number
}

type PartialBreakdown = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  calls?: number
}

/** A breakdown only when every count is present — an older payload omits them,
 *  and absence must show nothing rather than a zero that reads as measured. */
export function tokensOf(source: PartialBreakdown | null | undefined): TokenBreakdown | null {
  if (!source) return null
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = source
  if (inputTokens == null || outputTokens == null || cacheReadTokens == null || cacheWriteTokens == null) return null
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, calls: source.calls }
}

/** Totals over rows behind an aggregate amount; `divideBy` turns a sum into the
 *  average that an Avg/day figure is. */
export function sumTokens(rows: readonly PartialBreakdown[], divideBy = 1): TokenBreakdown | null {
  if (!rows.length || divideBy <= 0) return null
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  // One row without a call count makes the total unknown, not smaller: adding a
  // zero for it would print a Calls row that no source measured.
  let calls: number | undefined = 0
  for (const row of rows) {
    const t = tokensOf(row)
    if (!t) return null
    total.inputTokens += t.inputTokens
    total.outputTokens += t.outputTokens
    total.cacheReadTokens += t.cacheReadTokens
    total.cacheWriteTokens += t.cacheWriteTokens
    if (t.calls == null) calls = undefined
    else if (calls !== undefined) calls += t.calls
  }
  return {
    inputTokens: Math.round(total.inputTokens / divideBy),
    outputTokens: Math.round(total.outputTokens / divideBy),
    cacheReadTokens: Math.round(total.cacheReadTokens / divideBy),
    cacheWriteTokens: Math.round(total.cacheWriteTokens / divideBy),
    ...(calls === undefined ? {} : { calls: Math.round(calls / divideBy) }),
  }
}

/**
 * Hover/focus popover of the tokens behind a dollar amount, for an element that
 * renders its own text. `Usd` is the ordinary case; the hero's count-up owns its
 * text node, so it takes the parts directly.
 */
export function useUsdPop<T extends HTMLElement>(tokens: TokenBreakdown | null | undefined, nested = false): {
  ref: RefObject<T | null>
  props: Record<string, unknown>
  pop: ReactElement | null
} {
  const ref = useRef<T>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const id = useId()
  useEscape(open, () => setOpen(false))

  if (!tokens) return { ref, props: {}, pop: null }
  // Inside an interactive row (a session-row button) the trigger must not add its
  // own tab stop or steal the row's Enter, so there it is hover/mouse-only and
  // out of the tab order; standalone it stays keyboard-focusable.
  return {
    ref,
    props: {
      'data-usd': '',
      tabIndex: nested ? -1 : 0,
      'aria-describedby': open ? id : undefined,
      onMouseEnter: () => setOpen(true),
      onMouseLeave: () => setOpen(false),
      ...(nested ? {} : { onFocus: () => setOpen(true), onBlur: () => setOpen(false) }),
    },
    pop: open ? (
      <AnchoredSurface anchor={ref} surfaceRef={surfaceRef} id={id} className="pop-menu usd-pop" role="tooltip">
        <TokenRows tokens={tokens} />
      </AnchoredSurface>
    ) : null,
  }
}

/** The four counts, plus calls when the source carries them. */
export function TokenRows({ tokens }: { tokens: TokenBreakdown }): ReactElement {
  return (
    <>
      <div className="usd-pop-row"><span>Input</span><b>{formatCompact(tokens.inputTokens)}</b></div>
      <div className="usd-pop-row"><span>Output</span><b>{formatCompact(tokens.outputTokens)}</b></div>
      <div className="usd-pop-row"><span>Cache read</span><b>{formatCompact(tokens.cacheReadTokens)}</b></div>
      <div className="usd-pop-row"><span>Cache write</span><b>{formatCompact(tokens.cacheWriteTokens)}</b></div>
      {tokens.calls != null && <div className="usd-pop-row calls"><span>Calls</span><b>{formatCompact(tokens.calls)}</b></div>}
    </>
  )
}

/** A dollar amount that reveals its token breakdown on hover or focus. Without
 *  `tokens` it is the plain formatted amount and nothing else. */
export function Usd({ value, tokens, className, nested }: { value: number; tokens?: TokenBreakdown | null; className?: string; nested?: boolean }): ReactElement {
  const pop = useUsdPop<HTMLSpanElement>(tokens, nested)
  return (
    <>
      <span ref={pop.ref} className={className} {...pop.props}>{formatUsd(value)}</span>
      {pop.pop}
    </>
  )
}
