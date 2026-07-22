export type SegOption = { value: string; label: string; disabled?: boolean; loading?: boolean }

/** The `.seg` segmented control used for period and lens switching. */
export function SegTabs({
  options,
  value,
  onChange,
  style,
}: {
  options: SegOption[]
  value: string
  onChange: (value: string) => void
  style?: React.CSSProperties
}) {
  return (
    <div className="seg" role="tablist" style={style}>
      {options.map(opt => (
        <span
          key={opt.value}
          className={[opt.value === value ? 'on' : '', opt.disabled ? 'disabled' : ''].filter(Boolean).join(' ') || undefined}
          role="tab"
          aria-selected={opt.value === value}
          aria-disabled={opt.disabled || undefined}
          tabIndex={opt.disabled ? -1 : 0}
          onClick={() => { if (!opt.disabled) onChange(opt.value) }}
          onKeyDown={e => {
            if (!opt.disabled && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              onChange(opt.value)
            }
          }}
        >
          {opt.loading && <i className="seg-spinner" aria-hidden="true" />}
          {opt.label}
        </span>
      ))}
    </div>
  )
}
