type Props = { periodLabel: string }

export function LoadingOverlay({ periodLabel }: Props) {
  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="loading-spinner" />
        <div className="loading-text">Loading {periodLabel}</div>
      </div>
    </div>
  )
}
