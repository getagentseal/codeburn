import { contextBridge, ipcRenderer } from 'electron'

// Handlers resolve with { ok, value } | { ok, error } so the structured error
// `kind` survives the contextBridge boundary. `import type` is erased at build,
// so this shares main.ts's declaration without pulling its runtime in.
import type { Envelope } from './main'

type DateRange = { from: string; to: string }
type PriceRates = { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (res.ok) return res.value
  // Reject with a plain object so `kind` is preserved (Error subclasses lose
  // custom fields when cloned across worlds).
  return Promise.reject(res.error)
}

// Shape matches CodeburnBridge (app/renderer/lib/types.ts); typing is enforced
// renderer-side where `window.codeburn` is declared as CodeburnBridge.
const bridge = {
  getQuota: (force?: boolean, disabled?: string[]) => invoke('codeburn:getQuota', force, disabled),
  getOverview: (period: string, provider: string, range?: DateRange, configSource?: string | null, background?: boolean, scope?: string) => invoke('codeburn:getOverview', period, provider, range, configSource, background, scope),
  getTimeline: (period: string, provider: string, range?: DateRange) => invoke('codeburn:getTimeline', period, provider, range),
  getPlans: (period: string, background?: boolean) => invoke('codeburn:getPlans', period, background),
  getActReport: () => invoke('codeburn:getActReport'),
  getModels: (period: string, provider: string, byTask: boolean, range?: DateRange, background?: boolean) => invoke('codeburn:getModels', period, provider, byTask, range, background),
  getSessions: (period: string, provider: string, range?: DateRange, background?: boolean) => invoke('codeburn:getSessions', period, provider, range, background),
  getCompareModels: (period: string, provider: string, background?: boolean) => invoke('codeburn:getCompareModels', period, provider, background),
  getCompare: (period: string, provider: string, modelA: string, modelB: string) => invoke('codeburn:getCompare', period, provider, modelA, modelB),
  getYield: (period: string, provider: string, range?: DateRange, background?: boolean) => invoke('codeburn:getYield', period, provider, range, background),
  getSpendFlow: (period: string, provider: string, range?: DateRange, background?: boolean) => invoke('codeburn:getSpendFlow', period, provider, range, background),
  getOptimizeReport: (period: string, provider: string, range?: DateRange, background?: boolean) => invoke('codeburn:getOptimizeReport', period, provider, range, background),
  getDevices: (period: string) => invoke('codeburn:getDevices', period),
  getDevicesScan: () => invoke('codeburn:getDevicesScan'),
  getShareStatus: () => invoke('codeburn:getShareStatus'),
  getIdentity: () => invoke('codeburn:getIdentity'),
  getAliases: () => invoke('codeburn:getAliases'),
  getProxyPaths: () => invoke('codeburn:getProxyPaths'),
  getAudit: (period: string, provider: string, range?: DateRange) => invoke('codeburn:getAudit', period, provider, range),
  getPriceOverrides: () => invoke('codeburn:getPriceOverrides'),
  getProjectFilter: () => invoke('codeburn:getProjectFilter'),
  setProjectFilter: (filter: { project: string[]; exclude: string[] }) => invoke('codeburn:setProjectFilter', filter),
  getUnfilteredProjects: () => invoke('codeburn:getUnfilteredProjects'),
  setPriceOverride: (model: string, rates: PriceRates) => invoke('codeburn:setPriceOverride', model, rates),
  removePriceOverride: (model: string) => invoke('codeburn:removePriceOverride', model),
  setCurrency: (code: string) => invoke('codeburn:setCurrency', code),
  resetCurrency: () => invoke('codeburn:resetCurrency'),
  addAlias: (from: string, to: string) => invoke('codeburn:addAlias', from, to),
  removeAlias: (from: string) => invoke('codeburn:removeAlias', from),
  removeDevice: (name: string) => invoke('codeburn:removeDevice', name),
  setPlan: (id: string, provider: string) => invoke('codeburn:setPlan', id, provider),
  resetPlan: (provider: string) => invoke('codeburn:resetPlan', provider),
  exportData: (format: string, provider: string, outPath: string) => invoke('codeburn:exportData', format, provider, outPath),
  chooseDirectory: () => invoke('codeburn:chooseDirectory'),
  cliStatus: () => invoke('codeburn:cliStatus'),
  telemetryStatus: () => invoke('codeburn:telemetryStatus'),
  setTelemetryEnabled: (enabled: boolean) => invoke('codeburn:telemetrySetEnabled', enabled),
  completeOnboarding: (enabled: boolean) => invoke('codeburn:telemetryOnboarded', enabled),
  telemetryTrack: (name: string, props?: Record<string, unknown>) => invoke('codeburn:telemetryTrack', name, props),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  // Cold-start scan progress (main → renderer). Returns an unsubscribe fn.
  onProgress: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event)
    ipcRenderer.on('codeburn:progress', listener)
    return () => { ipcRenderer.removeListener('codeburn:progress', listener) }
  },
  // Update availability: a one-shot read plus a push for the launch + 24h checks.
  getUpdateStatus: () => invoke('codeburn:getUpdateStatus'),
  onUpdateStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status)
    ipcRenderer.on('codeburn:update', listener)
    return () => { ipcRenderer.removeListener('codeburn:update', listener) }
  },
  // The bundled tray app and its Capacity Dock (Windows). Every setter answers with the
  // whole status, so the sidebar renders what took rather than what it asked for.
  companionStatus: () => invoke('codeburn:companionStatus'),
  setMenuBarEnabled: (enabled: boolean) => invoke('codeburn:setMenuBarEnabled', enabled),
  setSidebarEnabled: (enabled: boolean) => invoke('codeburn:setSidebarEnabled', enabled),
  // The tray app's own settings, in the two files it reads them from.
  trayPrefs: () => invoke('codeburn:trayPrefs'),
  setTrayAppPref: (patch: Record<string, unknown>) => invoke('codeburn:setTrayAppPref', patch),
  setTrayDockPref: (patch: Record<string, unknown>) => invoke('codeburn:setTrayDockPref', patch),
  setLaunchAtLogin: (enabled: boolean) => invoke('codeburn:setLaunchAtLogin', enabled),
  // Plugin management
  pluginList: () => invoke('codeburn:pluginList'),
  pluginInfo: (name: string) => invoke('codeburn:pluginInfo', name),
  pluginAdd: (source: string) => invoke('codeburn:pluginAdd', source),
  pluginRemove: (name: string) => invoke('codeburn:pluginRemove', name),
  pluginVerify: (name: string) => invoke('codeburn:pluginVerify', name),
  // Sync auto
  syncAutoStatus: () => invoke('codeburn:syncAutoStatus'),
  syncAutoEnable: (cadence: string, attribution: boolean, accept: boolean) => invoke('codeburn:syncAutoEnable', cadence, attribution, accept),
  syncAutoDisable: () => invoke('codeburn:syncAutoDisable'),
  platform: process.platform,
  arch: process.arch,
}

contextBridge.exposeInMainWorld('codeburn', bridge)
