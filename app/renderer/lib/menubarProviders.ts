/**
 * The providers the menu bar app and the Capacity Dock can actually show a quota for: the
 * entries flagged `live: true` in the menubar's own catalog,
 * mac/Sources/CodeBurnMenubar/Data/ProviderConnectionCatalog.swift, which is where
 * `hasLiveCodeBurnQuotaAdapter` and every display name below come from.
 *
 * Copied rather than fetched: the desktop payload carries usage rows, not the menubar's
 * catalog, and a modal that lists what the menu bar supports must not depend on the menu bar
 * being installed to say it. menubarProviders.test.ts re-reads the Swift file and fails the
 * moment this list and that one disagree, so the copy cannot drift in silence.
 */
export const MENUBAR_QUOTA_PROVIDERS = [
  'Codex',
  'Claude',
  'ClinePass',
  'Cursor',
  'Gemini',
  'Antigravity',
  'Copilot',
  'Z.ai',
  'Kimi Code',
  'Grok',
  'Grok Bot',
] as const
