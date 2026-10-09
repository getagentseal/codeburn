import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'
import { CollapsibleSection } from './CollapsibleSection'
import { FixedBar } from './ActivitySection'
import { t } from '../i18n/index'

/// Port of ToolingSection in mac/.../Views/ToolingSection.swift: what the agent reached for,
/// in three lists. Skills and subagents are merged because from the reader's side they are
/// the same question ("what did I delegate to, and what did it cost").

type Merged = { name: string; uses: number; cost: number }

function skillsAndAgents(payload: MenubarPayload): Merged[] {
  const merged = new Map<string, Merged>()
  const add = (name: string, uses: number, cost: number) => {
    const entry = merged.get(name) ?? { name, uses: 0, cost: 0 }
    entry.uses += uses
    entry.cost += cost
    merged.set(name, entry)
  }
  for (const skill of payload.current.skills ?? []) add(skill.name, skill.turns, skill.cost)
  for (const agent of payload.current.subagents ?? []) add(agent.name, agent.calls, agent.cost)
  return [...merged.values()].sort((a, b) => b.cost - a.cost)
}

export function ToolingSection({ payload, currency }: { payload: MenubarPayload; currency: CurrencyState }) {
  const tools = payload.current.tools ?? []
  const mcpServers = payload.current.mcpServers ?? []
  const combined = skillsAndAgents(payload)
  if (tools.length === 0 && combined.length === 0 && mcpServers.length === 0) return null

  const maxToolCalls = Math.max(...tools.map(t => t.calls), 1)
  const maxMcpCalls = Math.max(...mcpServers.map(m => m.calls), 1)
  const maxCost = Math.max(...combined.map(d => d.cost), 0.01)

  return (
    <CollapsibleSection caption={t('Tooling')} defaultExpanded={false}>
      <div className="tooling-groups">
        {tools.length > 0 && (
          <div className="tooling-group">
            <div className="tooling-title">{t('Tools')}</div>
            {tools.map(tool => (
              <CallsRow key={tool.name} name={tool.name} calls={tool.calls} max={maxToolCalls} />
            ))}
          </div>
        )}
        {combined.length > 0 && (
          <div className="tooling-group">
            <div className="tooling-title">{t('Skills & Agents')}</div>
            {combined.map(entry => (
              <div key={entry.name} className="data-row">
                <FixedBar fraction={entry.cost / maxCost} />
                <span className="row-name">{entry.name}</span>
                <span className="row-count" style={{ minWidth: 30 }}>{entry.uses}</span>
                <span className="row-cost" style={{ minWidth: 46 }}>
                  {formatCompactCurrency(entry.cost, currency)}
                </span>
              </div>
            ))}
          </div>
        )}
        {mcpServers.length > 0 && (
          <div className="tooling-group">
            <div className="tooling-title">{t('MCP Servers')}</div>
            {mcpServers.map(server => (
              <CallsRow key={server.name} name={server.name} calls={server.calls} max={maxMcpCalls} />
            ))}
          </div>
        )}
      </div>
    </CollapsibleSection>
  )
}

function CallsRow({ name, calls, max }: { name: string; calls: number; max: number }) {
  return (
    <div className="data-row">
      <FixedBar fraction={calls / max} />
      <span className="row-name">{name}</span>
      <span className="row-count" style={{ minWidth: 36 }}>{calls}</span>
    </div>
  )
}
