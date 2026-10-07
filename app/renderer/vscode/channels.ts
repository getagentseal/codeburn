/** Every bridge method the webview forwards to the extension host, each sent as
 *  `codeburn:<name>`. The host answers these and nothing else. Telemetry, update
 *  checks and the desktop's tray and menu bar companions are absent on purpose:
 *  the webview answers those itself, without a round trip. */
export const FORWARDED_METHODS = [
  'getQuota', 'getOverview', 'getTimeline', 'getPlans', 'getActReport', 'getModels',
  'getSessions', 'getSessionsContributions', 'getSessionWhy', 'getCompareModels', 'getCompare',
  'getPeriodCompare', 'getPeriodCompareSessions', 'getCompareCohortModels', 'getCompareCohort',
  'getYield', 'getSpendFlow', 'getBranchSpend', 'getOptimizeReport', 'getOptimizeSnapshot',
  'getDevices', 'getDevicesScan', 'getShareStatus', 'getIdentity', 'getAliases', 'getProxyPaths',
  'getAudit', 'getPriceOverrides', 'getProjectFilter', 'setProjectFilter', 'getUnfilteredProjects',
  'setPriceOverride', 'removePriceOverride', 'setCurrency', 'resetCurrency', 'addAlias', 'removeAlias',
  'removeDevice', 'setPlan', 'resetPlan', 'exportData', 'chooseDirectory', 'cliStatus',
  'getLanguage', 'setLanguage', 'getCursorSync', 'setCursorSync',
  'pluginList', 'pluginInfo', 'pluginAdd', 'pluginRemove', 'pluginVerify',
  'syncAutoStatus', 'syncAutoEnable', 'syncAutoDisable',
  'openExternal', 'openIdeSettings', 'setIdeScope',
] as const

export type ForwardedMethod = typeof FORWARDED_METHODS[number]

/** Webview → host. */
export type WebviewMessage =
  | { type: 'invoke'; id: number; channel: string; args: unknown[] }
  | { type: 'action'; name: 'openDashboard' | 'openSection' | 'refresh' | 'openSettings' | 'setScope' | 'star' | 'dismissStar'; arg?: string }

/** Host → webview. */
export type HostMessage =
  | { type: 'result'; id: number; envelope: { ok: true; value: unknown } | { ok: false; error: { kind: string; message: string; cold?: true } } }
  | { type: 'progress'; event: unknown }
  | { type: 'command'; command: { section?: string; period?: string; refresh?: boolean } }
  | { type: 'summary'; state: unknown }
