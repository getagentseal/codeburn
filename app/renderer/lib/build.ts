// Build identity, injected at package time by vite `define` (see vite.config.ts)
// from the git sha + build date. Falls back to 'dev' under the dev server and
// unit tests, where `define` is absent. Shown in the splash footer and the About
// modal so a field report is never ambiguous about which build is running.
declare const __BUILD_SHA__: string
declare const __BUILD_DATE__: string

export const BUILD_SHA = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev'
export const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : ''
/** e.g. "a1b2c3d · 2026-07-16", or just the sha when no date is available. */
export const BUILD_STAMP = BUILD_DATE ? `${BUILD_SHA} · ${BUILD_DATE}` : BUILD_SHA
