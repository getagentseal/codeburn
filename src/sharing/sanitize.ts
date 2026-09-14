import type { MenubarPayload } from '../menubar-json.js'

// Strip identifying detail before usage leaves the device. We never share
// project names, branch names, file paths, or per-session detail (the strongest
// signal of "what you are working on"). We DO share aggregate numbers plus
// model, tool, task, subagent, skill, and MCP-server usage, since the dashboard
// surfaces those per device. If a user names a subagent/skill after a client, that name
// would travel; revisit if that becomes a concern.
export function sanitizeForSharing(payload: MenubarPayload): MenubarPayload {
  // Older peers may predate the history field even though current producers
  // always include it, so keep the boundary tolerant while sanitizing.
  const timeline = payload.history?.timeline
  // Live sessions name the project and branch in flight, the most identifying
  // block of all.
  const { liveSessions: _liveSessions, ...rest } = payload
  // Per-branch rows are keyed by the raw git branch, which encodes ticket ids,
  // customer names and feature codenames as readily as a project name does, so
  // they leave with the project and session rows rather than travelling verbatim.
  // PR rows carry the repository owner and name in both the full URL and the
  // `owner/repo#123` label, so they travel with them.
  const { byBranch: _byBranch, pullRequests: _pullRequests, ...current } = payload.current
  return {
    ...rest,
    current: {
      ...current,
      topProjects: [],
      topSessions: [],
    },
    history: {
      ...payload.history,
      ...(timeline ? {
        timeline: {
          ...timeline,
          sessionSeries: [],
          points: timeline.points.map(point => ({ ...point, sessions: [] })),
        },
      } : {}),
    },
  }
}
