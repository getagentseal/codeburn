import type { Period } from './PeriodTabs'
import { t } from '../i18n'
import { PERIOD_PHRASES } from './PeriodTabs'
import { TrayIcon } from './Icons'

type Props = {
  label: string
  period: Period
}

export function EmptyProviderState({ label, period }: Props) {
  return (
    <div className="empty-provider">
      <TrayIcon size={26} className="empty-provider-icon" />
      <div className="empty-provider-text">{t('No %1$@ data for %2$@', label, t(PERIOD_PHRASES[period]))}</div>
    </div>
  )
}
