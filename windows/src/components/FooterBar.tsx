import type { CurrencyState } from '../lib/currency'
import { CURRENCY_CODES } from '../lib/currency'
import { themeCycleLabel, type ThemeChoice } from '../lib/appSettings'
import { t, useI18nRevision } from '../lib/i18n'
import { TRAY_BADGE_SUPPORTED } from '../lib/platform'
import { DropMenu } from './DropMenu'
import { CoinIcon, DownloadIcon, EllipsisIcon, RefreshIcon, TerminalIcon } from './Icons'

type Props = {
  currency: CurrencyState
  onCurrency: (code: string) => void
  loading: boolean
  onRefresh: () => void
  onExport: (format: 'csv' | 'json') => void
  onOpenReport: () => void
  onToggleTheme: () => void
  onQuit: () => void
  theme: ThemeChoice
  footnote: string
  trayBadge: boolean
  onToggleTrayBadge: () => void
  onOpenSettings: () => void
}

export function FooterBar({
  currency, onCurrency, loading, onRefresh, onExport, onOpenReport, onToggleTheme, onQuit, theme, footnote,
  trayBadge, onToggleTrayBadge, onOpenSettings,
}: Props) {
  useI18nRevision()
  return (
    <footer className="footer">
      <DropMenu
        title="Currency"
        label={<><CoinIcon size={12} /><span>{currency.code}</span></>}
        items={CURRENCY_CODES.map(c => ({ id: c, label: c, checked: c === currency.code }))}
        columns={3}
        onSelect={onCurrency}
      />
      <button
        type="button"
        className={`btn btn-icon ${loading ? 'btn-spinning' : ''}`}
        title="Refresh"
        aria-label="Refresh"
        onClick={onRefresh}
        disabled={loading}
      >
        <RefreshIcon size={12} />
      </button>
      <DropMenu
        title="Export"
        label={<><DownloadIcon size={12} /><span>Export</span></>}
        items={[
          { id: 'csv', label: 'CSV (folder)' },
          { id: 'json', label: 'JSON' },
        ]}
        onSelect={id => onExport(id as 'csv' | 'json')}
      />
      <span className="footer-spacer" />
      <button type="button" className="btn btn-prominent" onClick={onOpenReport}>
        <TerminalIcon size={12} />
        <span>Open Full Report</span>
      </button>
      <DropMenu
        title="More"
        align="right"
        label={<EllipsisIcon size={12} />}
        className="dropmenu-more"
        items={[
          { id: 'settings', label: t('Settings…') },
          ...(TRAY_BADGE_SUPPORTED
            ? [{ id: 'badge', label: "Show today's cost in tray", checked: trayBadge, separatorBefore: true }]
            : []),
          { id: 'theme', label: themeCycleLabel(theme) },
          { id: 'quit', label: t('Quit CodeBurn'), separatorBefore: true },
        ]}
        footnote={footnote}
        onSelect={id => {
          if (id === 'settings') onOpenSettings()
          if (id === 'badge') onToggleTrayBadge()
          if (id === 'theme') onToggleTheme()
          if (id === 'quit') onQuit()
        }}
      />
    </footer>
  )
}
