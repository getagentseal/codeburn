type Props = {
  provider: string
  period: string
}

const PERIOD_PHRASES: Record<string, string> = {
  today: 'today',
  week: 'the last 7 days',
  '30days': 'the last 30 days',
  month: 'this month',
  all: 'all time',
}

const DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  pi: 'Pi',
}

export function EmptyProviderState({ provider, period }: Props) {
  const name = DISPLAY_NAMES[provider] ?? provider
  const phrase = PERIOD_PHRASES[period] ?? period

  return (
    <div className="empty-provider">
      <div className="empty-provider-icon">📭</div>
      <div className="empty-provider-text">No {name} data for {phrase}</div>
    </div>
  )
}
