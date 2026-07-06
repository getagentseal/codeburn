import type { MenubarPayload } from '../menubar-json.js'

// Strip identifying detail before usage leaves the device. We never share
// project names, file paths, or per-session detail (the strongest signal of
// "what you are working on"). We DO share aggregate numbers plus model, tool,
// task, subagent, skill, and MCP-server usage, since the dashboard surfaces
// those per device. If a user names a subagent/skill after a client, that name
// would travel; revisit if that becomes a concern.
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
