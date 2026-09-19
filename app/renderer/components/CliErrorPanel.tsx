import { Panel } from './Panel'
import type { CliError } from '../lib/types'

export function isPermissionCliError(error: CliError | null): boolean {
  return error?.kind === 'nonzero' && /permission|full disk access|eacces/i.test(error.message)
}

/** A failure the main process attributed to a still-running cold hydration. The
 *  data is coming, so nothing here is broken — never paint it red. */
export function isColdHydrating(error: CliError | null): boolean {
  return error?.cold === true
}

export function cliErrorDisplay(error: CliError): { title: string; message: string; tone: 'amber' | 'red' | 'muted' } {
  if (isColdHydrating(error)) {
    return {
      title: 'Still indexing',
      message: 'Reading your usage history for the first time. This can take a few minutes.',
      tone: 'muted',
    }
  }
  if (error.kind === 'not-found') {
    return {
      title: 'Locate the codeburn CLI',
      message: 'Install it with npm i -g codeburn, then reopen this window.',
      tone: 'muted',
    }
  }
  if (isPermissionCliError(error)) {
    return {
      title: 'Permission denied',
      message: 'permission denied; grant Full Disk Access',
      tone: 'amber',
    }
  }
  return { title: "Couldn't read data", message: error.message, tone: 'red' }
}

function colorForTone(tone: 'amber' | 'red' | 'muted'): string {
  if (tone === 'amber') return 'var(--warn)'
  if (tone === 'red') return 'var(--bad)'
  return 'var(--mut2)'
}

export function CliErrorText({ error }: { error: CliError }) {
  const display = cliErrorDisplay(error)
  return <p style={{ color: colorForTone(display.tone), margin: 0, fontSize: 'var(--fs-meta)' }}>{display.message}</p>
}

export function CliErrorPanel({ error, subject = 'usage' }: { error: CliError; subject?: string }) {
  const display = cliErrorDisplay(error)
  if (error.kind === 'not-found') {
    return (
      <Panel title={display.title}>
        <p style={{ color: 'var(--mut)', margin: '0 0 6px', fontSize: 'var(--fs-body)' }}>
          CodeBurn Desktop reads {subject} by running the{' '}
          <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>codeburn</code> command, but it isn&apos;t
          on your PATH yet.
        </p>
        <p style={{ color: colorForTone(display.tone), margin: 0, fontSize: 'var(--fs-meta)' }}>
          Install it with <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>npm i -g codeburn</code>,
          then reopen this window.
        </p>
      </Panel>
    )
  }
  return (
    <Panel title={display.title}>
      <CliErrorText error={error} />
    </Panel>
  )
}
