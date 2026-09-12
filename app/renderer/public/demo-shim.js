// DEMO HARNESS — NOT SHIPPED. Stands in for the Electron preload bridge so the
// renderer runs in a plain browser tab against demo-bridge.mjs. Read-only:
// mutations resolve as successful no-ops, subscriptions return no-op
// unsubscribers, and anything unimplemented resolves null via the Proxy.
(() => {
  const call = (channel) => (...args) =>
    fetch('http://127.0.0.1:4900/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    }).then((r) => {
      if (!r.ok) throw { kind: 'nonzero', message: 'demo bridge error' }
      return r.json()
    })

  const okAction = () => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 })
  const unsub = () => () => {}

  const base = {
    platform: 'darwin',
    arch: 'arm64',
    onProgress: unsub,
    onUpdateStatus: unsub,
    getUpdateStatus: () => Promise.resolve({ currentVersion: '0.9.20', latestVersion: null, updateAvailable: false, tag: null }),
    getQuota: () => Promise.resolve([]),
    getDevicesScan: () => Promise.resolve({ devices: [] }),
    cliStatus: () => Promise.resolve({ found: true, path: 'bundled (demo)' }),
    telemetryStatus: () => Promise.resolve({ enabled: false, onboarded: true }),
    setTelemetryEnabled: () => Promise.resolve(null),
    completeOnboarding: () => Promise.resolve(null),
    telemetryTrack: () => Promise.resolve(false),
    openExternal: (url) => { window.open(url, '_blank'); return Promise.resolve() },
    chooseDirectory: () => Promise.resolve(null),
    setCurrency: okAction, resetCurrency: okAction,
    addAlias: okAction, removeAlias: okAction,
    setPriceOverride: okAction, removePriceOverride: okAction,
    removeDevice: okAction, setPlan: okAction, resetPlan: okAction,
    exportData: okAction,
  }

  const READ_CHANNELS = [
    'getOverview', 'getTimeline', 'getPlans', 'getModels', 'getSessions', 'getSessionsContributions',
    'getCompareModels', 'getCompare', 'getYield', 'getSpendFlow',
    'getOptimizeReport', 'getAudit', 'getActReport', 'getShareStatus',
    'getIdentity', 'getAliases', 'getProxyPaths', 'getPriceOverrides', 'getDevices',
  ]
  for (const channel of READ_CHANNELS) base[channel] = call(channel)

  window.codeburn = new Proxy(base, {
    get: (target, key) => key in target ? target[key] : () => Promise.resolve(null),
  })

  // Background tabs never tick CSS animations, so the section entrance fade
  // freezes at opacity 0 during automated capture. Skip it entirely in the demo.
  const style = document.createElement('style')
  style.textContent = '.section-fade { animation: none !important; opacity: 1 !important; }'
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style))
})()
