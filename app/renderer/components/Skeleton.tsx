/**
 * First-load placeholder: CSS shimmer blocks shown while a section has no data
 * and no error. The visible blocks are aria-hidden; the real loading text is
 * kept for screen readers via a visually-hidden status node.
 */
export function SectionSkeleton({ label, rows = 4, chart = false }: { label: string; rows?: number; chart?: boolean }) {
  return (
    <div className="panel skel-card">
      <span className="sr-only" role="status">{label}</span>
      <div className="phead skel-head" aria-hidden="true">
        <span className="skel skel-line" style={{ width: '38%' }} />
      </div>
      <div className="pbody skel-body" aria-hidden="true">
        {chart && <span className="skel skel-chart" />}
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className="skel skel-line" style={{ width: `${88 - index * 13}%` }} />
        ))}
      </div>
    </div>
  )
}
