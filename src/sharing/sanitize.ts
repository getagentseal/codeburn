import type { MenubarPayload } from '../menubar-json.js'

// Strip identifying detail before usage leaves the device. We share aggregate
// numbers (cost, tokens, models, tools, activities, daily) but never project
// names, paths, or per-session detail, so "what you are working on" stays on
// the machine that produced it. Only the totals travel.
export function sanitizeForSharing(payload: MenubarPayload): MenubarPayload {
  return {
    ...payload,
    current: {
      ...payload.current,
      topProjects: [],
      topSessions: [],
    },
  }
}
