import { useState } from 'react'
import { ACCENT_PRESETS, type AccentPreset } from '../lib/accent'
import { QuotaWarningRow } from './QuotaWarningRow'
import { UpdateBadge } from './UpdateBadge'
import type { QuotaState } from '../lib/quota'
import { t } from '../i18n'

/// Port of Header in mac/Sources/CodeBurnMenubar/Views/MenuBarContent.swift: the flame
/// wordmark and tagline on the left, the update badge and the accent picker on the right,
/// and the quota warning row underneath.

type Props = {
  quota: QuotaState
  showQuota: boolean
  accent: AccentPreset
  onAccent: (preset: AccentPreset) => void
  animate: boolean
}

export function Header({ quota, showQuota, accent, onAccent, animate }: Props) {
  return (
    <header className="header">
      <div className="header-top">
        <div className="header-brand">
          <FlameWordmark animate={animate} />
          <div className="subhead">{t('Your AI Bill, Itemized')}</div>
        </div>
        <div className="header-actions">
          <UpdateBadge />
          <AccentPicker accent={accent} onAccent={onAccent} />
        </div>
      </div>
      {showQuota && <QuotaWarningRow quota={quota} />}
    </header>
  )
}

/// The website's `.flame-text`: a 300 percent wide flame gradient clipped to the letters and
/// swept by `flameShift 3s ease infinite`. The sweep pauses while the popover is hidden, as
/// on the mac, where an always-running animation cost 5 to 7 percent idle CPU.
function FlameWordmark({ animate }: { animate: boolean }) {
  return (
    <div className={`brand brand-flame ${animate ? '' : 'is-still'}`} aria-label="CodeBurn">
      CodeBurn
    </div>
  )
}

function AccentPicker({ accent, onAccent }: { accent: AccentPreset; onAccent: (p: AccentPreset) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="accent-picker">
      {open && (
        <div className="accent-swatches">
          {ACCENT_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className={`accent-swatch ${preset.id === accent.id ? 'is-selected' : ''}`}
              style={{ background: preset.base }}
              aria-label={t(preset.label)}
              aria-pressed={preset.id === accent.id}
              onClick={() => onAccent(preset)}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className="accent-current"
        style={{ background: accent.base }}
        aria-label={t('Change accent color')}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      />
    </div>
  )
}
