export type SegOption = { value: string; label: string }

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
          className={opt.value === value ? 'on' : undefined}
          role="tab"
          aria-selected={opt.value === value}
          tabIndex={0}
          onClick={() => onChange(opt.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onChange(opt.value)
            }
          }}
        >
          {opt.label}
        </span>
      ))}
    </div>
  )
}
