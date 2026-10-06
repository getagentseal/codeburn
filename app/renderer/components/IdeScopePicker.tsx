import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { Dropdown } from './Dropdown'

/** The IDE's project scope: this workspace's projects, or every project. */
export function IdeScopePicker({ scope }: { scope: { workspace: boolean; label: string | null } }) {
  if (!scope.label) return null
  return (
    <Dropdown
      id="ide-scope"
      ariaLabel={t('ide.scope.ariaLabel')}
      value={scope.workspace ? 'workspace' : 'all'}
      options={[
        { value: 'workspace', label: scope.label },
        { value: 'all', label: t('ide.scope.all') },
      ]}
      onChange={value => { void codeburn.setIdeScope?.(value === 'workspace') }}
      width={160}
      footer={t('ide.scope.footer')}
    />
  )
}
