/** The `.pop` provider selector. Mutation (opening the menu) lands in T8. */
export function ProviderPop({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <div className="pop" role="button" tabIndex={0} onClick={onClick}>
      {label}
    </div>
  )
}
