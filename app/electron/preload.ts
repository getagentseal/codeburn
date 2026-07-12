import { contextBridge, ipcRenderer } from 'electron'

// Handlers resolve with { ok, value } | { ok, error } so the structured error
// `kind` survives the contextBridge boundary. `import type` is erased at build,
// so this shares main.ts's declaration without pulling its runtime in.
import type { Envelope } from './main'

type DateRange = { from: string; to: string }

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
  getOverview: (period: string, provider: string, range?: DateRange) => invoke('codeburn:getOverview', period, provider, range),
  getPlans: (period: string) => invoke('codeburn:getPlans', period),
  getActReport: () => invoke('codeburn:getActReport'),
  getModels: (period: string, provider: string, byTask: boolean, range?: DateRange) => invoke('codeburn:getModels', period, provider, byTask, range),
  getSessions: (period: string, provider: string, range?: DateRange) => invoke('codeburn:getSessions', period, provider, range),
  getCompareModels: (period: string, provider: string) => invoke('codeburn:getCompareModels', period, provider),
  getCompare: (period: string, provider: string, modelA: string, modelB: string) => invoke('codeburn:getCompare', period, provider, modelA, modelB),
  getYield: (period: string, range?: DateRange) => invoke('codeburn:getYield', period, range),
  getSpendFlow: (period: string, provider: string, range?: DateRange) => invoke('codeburn:getSpendFlow', period, provider, range),
  getDevices: (period: string) => invoke('codeburn:getDevices', period),
  getDevicesScan: () => invoke('codeburn:getDevicesScan'),
  getShareStatus: () => invoke('codeburn:getShareStatus'),
  getIdentity: () => invoke('codeburn:getIdentity'),
  getAliases: () => invoke('codeburn:getAliases'),
  getProxyPaths: () => invoke('codeburn:getProxyPaths'),
  setCurrency: (code: string) => invoke('codeburn:setCurrency', code),
  resetCurrency: () => invoke('codeburn:resetCurrency'),
  addAlias: (from: string, to: string) => invoke('codeburn:addAlias', from, to),
  removeAlias: (from: string) => invoke('codeburn:removeAlias', from),
  cliStatus: () => invoke('codeburn:cliStatus'),
  platform: process.platform,
}

contextBridge.exposeInMainWorld('codeburn', bridge)
