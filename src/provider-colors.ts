export const PROVIDER_COLORS: Record<string, string> = {
  all: '#FF8C42',
  claude: '#FF8C42',
  codex: '#5BF5A0',
  cursor: '#00B4D8',
  opencode: '#A78BFA',
  pi: '#F472B6',
  copilot: '#6495ED',
}

const PROVIDER_LABELS: Record<string, string> = {
  all: 'All',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
  copilot: 'Copilot',
}

export function providerLabel(name: string): string {
  return PROVIDER_LABELS[name] ?? name
}

export function providerColor(name: string): string {
  return PROVIDER_COLORS[name] ?? '#CCCCCC'
}
