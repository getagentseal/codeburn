/// First-run copy for a machine where the CLI ran fine but found no sessions. The watched
/// locations are the CLI's own roots, from lib/watched, which the tab strip's known-tool
/// fallback reads too, so the two surfaces cannot describe the same tool differently.

import { WATCHED_TOOLS } from '../lib/watched'
import { t } from '../i18n/index'

export function NoDataState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <section className="no-data">
      <h2 className="no-data-title">{t('No session data yet')}</h2>
      <p>
        CodeBurn reads local session logs written by your AI coding tools. None of the
        supported tools have recorded a session on this machine yet.
      </p>
      <p className="no-data-sub">{t('Watched locations')}</p>
      <ul>
        {WATCHED_TOOLS.map(t => (
          <li key={t.id}>
            <code>{t.path}</code> <span className="no-data-tool">{t.tool}</span>
          </li>
        ))}
      </ul>
      <p>{t('Run one of those tools for a session, then refresh.')}</p>
      <button type="button" className="btn" onClick={onRefresh}>{t('Refresh now')}</button>
    </section>
  )
}
