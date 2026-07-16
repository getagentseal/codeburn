import { Dropdown } from './Dropdown'
import { ProviderLogo } from './ProviderLogo'

export type ProviderOption = { value: string; label: string }

/**
 * Provider selector built on the Dropdown listbox (roving tabindex, arrow-key
 * navigation, one tab stop, focus-visible ring via `.dropdown-trigger`), with a
 * provider logo rendered in the trigger and each option. `label` is retained for
 * API compatibility; the Dropdown derives the display label from `options`.
 */
export function ProviderPop({
  value,
  options,
  onSelect,
}: {
  value: string
  label: string
  options: ProviderOption[]
  onSelect: (value: string) => void
}) {
  return (
    <Dropdown
      id="provider-select"
      ariaLabel="Providers"
      value={value}
      options={options}
      onChange={onSelect}
      renderIcon={provider => <ProviderLogo provider={provider} />}
    />
  )
}
