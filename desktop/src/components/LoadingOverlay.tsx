type Props = { periodLabel: string }

export function LoadingOverlay({ periodLabel }: Props) {
  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="loading-flame">
          <div className="flame-outline">🔥</div>
          <div className="flame-fill">🔥</div>
        </div>
        <div className="loading-text">Loading {periodLabel}…</div>
      </div>
    </div>
  )
}
