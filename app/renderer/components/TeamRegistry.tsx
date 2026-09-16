import { ReactNode, useEffect, useState } from 'react'
import type { MenubarPayload } from '../lib/types'
import { Icon } from './icons'

export type TeamTab = 'teams.week' | 'teams.status' | string

interface TeamRegistryProps {
  payload: MenubarPayload | null
  loading?: boolean
  onNavigate?: (tab: TeamTab) => void
}

interface TeamTabConfig {
  id: string
  label: string
  icon: ReactNode
}

export function useTeamTabs(payload: MenubarPayload | null): TeamTabConfig[] {
  const [tabs, setTabs] = useState<TeamTabConfig[]>([])

  useEffect(() => {
    if (!payload?.current) {
      setTabs([])
      return
    }

    const newTabs: TeamTabConfig[] = []
    const pluginsRecord = (payload.current as any).plugins

    if (!pluginsRecord || typeof pluginsRecord !== 'object') {
      setTabs([])
      return
    }

    for (const key of Object.keys(pluginsRecord)) {
      if (key.startsWith('teams.')) {
        if (key === 'teams.week') {
          newTabs.push({
            id: 'teams.week',
            label: 'Team Week',
            icon: <Icon name="circle-check" />,
          })
        } else if (key === 'teams.status') {
          newTabs.push({
            id: 'teams.status',
            label: 'Team Status',
            icon: <Icon name="zap" />,
          })
        } else {
          newTabs.push({
            id: key,
            label: `Unknown (${key})`,
            icon: <Icon name="circle" />,
          })
        }
      }
    }

    setTabs(newTabs)
  }, [payload])

  return tabs
}

export function TeamTabContent({ payload, tab }: { payload: MenubarPayload; tab: string }): ReactNode {
  if (!payload.current) return null

  const pluginsRecord = (payload.current as any).plugins ?? {}
  const tabData = pluginsRecord[tab]

  if (!tabData) {
    return <div style={{ padding: '1rem', color: 'var(--mut)' }}>Team data not available</div>
  }

  if (tab === 'teams.week') {
    if (typeof tabData === 'object' && 'spend' in tabData && 'sessions' in tabData) {
      return (
        <div style={{ padding: '1.5rem', display: 'flex', gap: '1.5rem' }}>
          <div style={{
            flex: 1,
            padding: '1rem',
            background: 'var(--fill)',
            borderRadius: '8px',
            border: '1px solid var(--line)',
          }}>
            <div style={{ fontSize: '0.875rem', color: 'var(--mut)', marginBottom: '0.5rem' }}>Total spend</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>${tabData.spend?.toFixed(2) ?? '0.00'}</div>
          </div>
          <div style={{
            flex: 1,
            padding: '1rem',
            background: 'var(--fill)',
            borderRadius: '8px',
            border: '1px solid var(--line)',
          }}>
            <div style={{ fontSize: '0.875rem', color: 'var(--mut)', marginBottom: '0.5rem' }}>Sessions</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{tabData.sessions ?? 0}</div>
          </div>
          {Array.isArray(tabData.topWorkUnits) && (
            <div style={{
              flex: 1,
              padding: '1rem',
              background: 'var(--fill)',
              borderRadius: '8px',
              border: '1px solid var(--line)',
            }}>
              <div style={{ fontSize: '0.875rem', color: 'var(--mut)', marginBottom: '0.75rem' }}>Top work units</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {tabData.topWorkUnits.slice(0, 3).map((unit: any, i: number) => (
                  <div key={i} style={{ fontSize: '0.75rem', color: 'var(--ink)' }}>
                    {unit.name}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )
    }
    return <div style={{ padding: '1rem', color: 'var(--mut)' }}>Team week data not available</div>
  }

  if (tab === 'teams.status') {
    if (typeof tabData === 'string' && tabData.startsWith('http')) {
      return (
        <div style={{ padding: '1.5rem' }}>
          <a
            href={tabData}
            onClick={e => {
              e.preventDefault()
              const { codeburn } = require('../lib/ipc')
              void codeburn.openExternal(tabData)
            }}
            style={{
              display: 'inline-block',
              padding: '0.75rem 1.5rem',
              background: 'var(--accent)',
              color: 'white',
              borderRadius: '6px',
              textDecoration: 'none',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            View team status
          </a>
        </div>
      )
    }
    return <div style={{ padding: '1rem', color: 'var(--mut)' }}>Team status not available</div>
  }

  if (typeof tabData === 'object' && tabData.schemaVersion && (tabData as any).schemaVersion > 1) {
    return (
      <div style={{ padding: '1.5rem', color: 'var(--warn)' }}>
        Update CodeBurn Desktop to view this content. This plugin data requires a newer version of CodeBurn.
      </div>
    )
  }

  return (
    <div style={{ padding: '1rem', color: 'var(--mut)' }}>
      Unknown team tab: {tab}
    </div>
  )
}
