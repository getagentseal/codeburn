import type { ProjectSummary } from "../types.js";
import {
  TOKENS_PER_MCP_TOOL,
  TOOLS_PER_MCP_SERVER,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_DISCOUNT,
  MCP_COVERAGE_MIN_TOOLS,
  MCP_COVERAGE_MIN_SESSIONS,
  MCP_COVERAGE_LOW_THRESHOLD,
  MCP_COVERAGE_HIGH_IMPACT_TOKENS,
  UNUSED_MCP_HIGH_THRESHOLD,
  MCP_NEW_CONFIG_GRACE_MS,
} from "./constants.js";
import type {
  ToolCall,
  WasteFinding,
  Impact,
  McpServerCoverage,
  McpSchemaCostEstimate,
} from "./types.js";
import { loadMcpConfigs } from "./scan.js";

/**
 * Aggregate MCP inventory and invocations across the projects in scope.
 *
 * Returns one entry per `mcp__<server>__*` namespace observed in any
 * session's `mcpInventory`. Counts of invocations come from
 * `session.mcpBreakdown` (per-server call totals already maintained by the
 * parser).
 */
export function aggregateMcpCoverage(
  projects: ProjectSummary[],
): McpServerCoverage[] {
  type ServerAcc = {
    inventory: Set<string>;
    invokedTools: Set<string>;
    invocations: number;
    loadedSessions: number;
  };
  const servers = new Map<string, ServerAcc>();

  function getOrInit(server: string): ServerAcc {
    let acc = servers.get(server);
    if (!acc) {
      acc = {
        inventory: new Set(),
        invokedTools: new Set(),
        invocations: 0,
        loadedSessions: 0,
      };
      servers.set(server, acc);
    }
    return acc;
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      // Only sessions with an observed inventory count toward `loadedSessions`.
      // Pure invocation-only sessions (server seen via `call.mcpTools` or
      // `session.mcpBreakdown` without any matching `deferred_tools_delta`)
      // could otherwise satisfy the `MCP_COVERAGE_MIN_SESSIONS` threshold
      // without giving us evidence that the schema was actually loaded.
      const inventoriedServers = new Set<string>();
      const sessionInvoked = new Map<string, Set<string>>();

      // Inventory: union of tools observed available in this session.
      for (const fqn of session.mcpInventory ?? []) {
        const parts = fqn.split("__");
        if (parts.length < 3 || parts[0] !== "mcp") continue;
        const server = parts[1];
        if (!server) continue;
        const tool = parts.slice(2).join("__");
        if (!tool) continue;
        const acc = getOrInit(server);
        acc.inventory.add(fqn);
        inventoriedServers.add(server);
      }

      // Invoked tools: walk turns to collect per-tool invocations. We can't
      // get this from session.mcpBreakdown alone because that's keyed by
      // server, not tool.
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          for (const fqn of call.mcpTools) {
            const parts = fqn.split("__");
            if (parts.length < 3 || parts[0] !== "mcp") continue;
            const server = parts[1];
            if (!server) continue;
            let invoked = sessionInvoked.get(server);
            if (!invoked) {
              invoked = new Set();
              sessionInvoked.set(server, invoked);
            }
            invoked.add(fqn);
          }
        }
      }

      // Invocation totals: trust mcpBreakdown which was already aggregated
      // turn-by-turn, including any invocations the inventory pass missed.
      for (const [server, data] of Object.entries(session.mcpBreakdown)) {
        const acc = getOrInit(server);
        acc.invocations += data.calls;
      }

      for (const [server, invoked] of sessionInvoked) {
        const acc = getOrInit(server);
        for (const fqn of invoked) acc.invokedTools.add(fqn);
      }

      for (const server of inventoriedServers) {
        getOrInit(server).loadedSessions += 1;
      }
    }
  }

  const result: McpServerCoverage[] = [];
  for (const [server, acc] of servers) {
    if (acc.inventory.size === 0) continue;
    // Coverage is only meaningful against tools we actually observed in the
    // inventory: invocations of tools never inventoried (older config, typo,
    // etc.) would otherwise inflate the numerator and could even drive
    // `unusedCount` negative.
    const invokedInInventory = new Set<string>();
    for (const fqn of acc.invokedTools) {
      if (acc.inventory.has(fqn)) invokedInInventory.add(fqn);
    }
    const unusedTools = Array.from(acc.inventory)
      .filter((t) => !invokedInInventory.has(t))
      .sort();
    const toolsInvoked = acc.inventory.size - unusedTools.length;
    result.push({
      server,
      toolsAvailable: acc.inventory.size,
      toolsInvoked,
      unusedTools,
      invocations: acc.invocations,
      loadedSessions: acc.loadedSessions,
      coverageRatio:
        acc.inventory.size === 0 ? 0 : toolsInvoked / acc.inventory.size,
    });
  }
  result.sort((a, b) => b.toolsAvailable - a.toolsAvailable);
  return result;
}

/**
 * Cache-aware token cost estimate for the unused-tool overhead of one or
 * more servers, summed across all sessions that loaded any of them.
 *
 * Returns three buckets:
 * - `cacheWriteTokens`: schema bytes paid at full input price (each
 *    cache-creation event in a session that loaded one of the servers).
 * - `cacheReadTokens`: schema bytes carried at the cache-read discount on
 *    subsequent turns (ongoing overhead).
 * - `effectiveInputTokens`: equivalent fresh-input tokens, weighted by
 *    cache pricing. Used to estimate dollar cost downstream by multiplying
 *    by the project's input rate.
 *
 * We cap each call's contribution at the observed cache-creation /
 * cache-read totals for that call: it is not meaningful to claim more MCP
 * overhead than the call's own cache bucket could possibly contain. The
 * cap is applied once across the combined unused-schema budget for all
 * flagged servers, not per server, so two flagged servers cannot both
 * independently claim the same call's cache bucket.
 *
 * Anthropic caches expire after roughly 5 minutes of inactivity, so a long
 * session can rebuild the cache multiple times. Every call that reports
 * `cacheCreationInputTokens > 0` is treated as another rebuild, not just
 * the very first one.
 *
 * "Loaded" is defined exclusively by observed inventory: a session that
 * invoked a server without ever emitting a `deferred_tools_delta` for it
 * does not count, matching the invariant `aggregateMcpCoverage` uses for
 * `loadedSessions`.
 */
export function estimateMcpSchemaCost(
  unusedToolCount: number,
  projects: ProjectSummary[],
  server: string,
): McpSchemaCostEstimate;
export function estimateMcpSchemaCost(
  unusedToolCountsByServer: Record<string, number>,
  projects: ProjectSummary[],
  servers: string[],
): McpSchemaCostEstimate;
export function estimateMcpSchemaCost(
  unusedToolCounts: Record<string, number> | number,
  projects: ProjectSummary[],
  serverOrServers: string | string[],
): McpSchemaCostEstimate {
  let servers: string[];
  let counts: Record<string, number>;
  if (typeof unusedToolCounts === "number") {
    if (typeof serverOrServers !== "string") {
      throw new TypeError(
        "single-server MCP cost estimates require a string server name",
      );
    }
    servers = [serverOrServers];
    counts = { [serverOrServers]: unusedToolCounts };
  } else {
    if (!Array.isArray(serverOrServers)) {
      throw new TypeError(
        "multi-server MCP cost estimates require a string[] server list",
      );
    }
    servers = serverOrServers;
    counts = unusedToolCounts;
  }

  const totalUnusedSchemaTokens = servers.reduce(
    (s, srv) => s + (counts[srv] ?? 0) * TOKENS_PER_MCP_TOOL,
    0,
  );
  if (totalUnusedSchemaTokens === 0) {
    return { cacheWriteTokens: 0, cacheReadTokens: 0, effectiveInputTokens: 0 };
  }

  const serverSet = new Set(servers);
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;

  for (const project of projects) {
    for (const session of project.sessions) {
      // A session counts only if its observed inventory included at least
      // one of the flagged servers — same invariant `aggregateMcpCoverage`
      // uses for `loadedSessions`.
      let loaded = false;
      for (const fqn of session.mcpInventory ?? []) {
        const seg = fqn.split("__")[1];
        if (seg && serverSet.has(seg)) {
          loaded = true;
          break;
        }
      }
      if (!loaded) continue;

      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          // Both buckets can be non-zero on the same call (cache rebuild
          // alongside a partial read), so account for them independently.
          // The cap is applied to the combined unused-schema budget so
          // multiple flagged servers cannot all claim the same call.
          if (call.usage.cacheCreationInputTokens > 0) {
            cacheWriteTokens += Math.min(
              totalUnusedSchemaTokens,
              call.usage.cacheCreationInputTokens,
            );
          }
          if (call.usage.cacheReadInputTokens > 0) {
            cacheReadTokens += Math.min(
              totalUnusedSchemaTokens,
              call.usage.cacheReadInputTokens,
            );
          }
        }
      }
    }
  }

  const effectiveInputTokens =
    cacheWriteTokens * CACHE_WRITE_MULTIPLIER +
    cacheReadTokens * CACHE_READ_DISCOUNT;
  return { cacheWriteTokens, cacheReadTokens, effectiveInputTokens };
}

/**
 * Find MCP servers whose tool inventory is largely unused. Replaces the
 * older server-only `detectUnusedMcp` (which only flagged servers with
 * literal zero invocations).
 *
 * A server is flagged when, taken together:
 *   - it exposed more than `MCP_COVERAGE_MIN_TOOLS` tools,
 *   - we saw it loaded in at least `MCP_COVERAGE_MIN_SESSIONS` sessions,
 *   - the coverage ratio is below `MCP_COVERAGE_LOW_THRESHOLD`.
 *
 * Token-savings estimates use the cache-aware accounting from
 * `estimateMcpSchemaCost` so we don't mistake cached-prefix carry-over for
 * fresh-input billing.
 */
export function detectMcpToolCoverage(
  projects: ProjectSummary[],
  coverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  if (coverage.length === 0) return null;

  const flagged = coverage.filter(
    (c) =>
      c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS &&
      c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS &&
      c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
  );
  if (flagged.length === 0) return null;

  flagged.sort(
    (a, b) =>
      b.toolsAvailable - b.toolsInvoked - (a.toolsAvailable - a.toolsInvoked),
  );

  const lines: string[] = [];
  const removeCommands: string[] = [];
  const unusedCountsByServer: Record<string, number> = {};
  const flaggedServers: string[] = [];

  for (const c of flagged) {
    unusedCountsByServer[c.server] = c.toolsAvailable - c.toolsInvoked;
    flaggedServers.push(c.server);
    const pct = Math.round(c.coverageRatio * 100);
    lines.push(
      `${c.server}: ${c.toolsInvoked}/${c.toolsAvailable} tools used (${pct}% coverage) across ${c.loadedSessions} session${c.loadedSessions === 1 ? "" : "s"}`,
    );
    removeCommands.push(`claude mcp remove '${c.server}'`);
  }

  // Single combined cost pass: caps each call's contribution at the
  // total unused-schema budget across all flagged servers, so two
  // flagged servers cannot independently claim the same call's cache
  // bucket and overstate `tokensSaved`.
  const cost = estimateMcpSchemaCost(
    unusedCountsByServer,
    projects,
    flaggedServers,
  );
  const tokensSaved = Math.round(cost.effectiveInputTokens);
  const impact: Impact =
    tokensSaved >= MCP_COVERAGE_HIGH_IMPACT_TOKENS
      ? "high"
      : flagged.length >= UNUSED_MCP_HIGH_THRESHOLD
        ? "high"
        : "medium";

  return {
    title: `${flagged.length} MCP server${flagged.length === 1 ? "" : "s"} with low tool coverage`,
    explanation:
      `Schema for unused tools is loaded into the system prompt every session and ` +
      `carried in the cached prefix on every turn. ` +
      `${lines.join("; ")}.`,
    impact,
    tokensSaved,
    fix: {
      type: "command",
      label:
        flagged.length === 1
          ? "Remove the underused server, or trim its tools in your MCP config:"
          : "Remove underused servers, or trim their tools in your MCP config:",
      text: removeCommands.join("\n"),
    },
  };
}

export function detectUnusedMcp(
  calls: ToolCall[],
  projects: ProjectSummary[],
  projectCwds: Set<string>,
  mcpCoverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  const configured = loadMcpConfigs(projectCwds);
  if (configured.size === 0) return null;

  const calledServers = new Set<string>();
  for (const call of calls) {
    if (!call.name.startsWith("mcp__")) continue;
    const seg = call.name.split("__")[1];
    if (seg) calledServers.add(seg);
  }
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const server of Object.keys(s.mcpBreakdown))
        calledServers.add(server);
    }
  }

  // Servers that the new coverage detector will flag fall under its
  // jurisdiction (per-tool granularity, cache-aware costing) and we
  // suppress them here to avoid double-flagging. Importantly, we suppress
  // only the servers that actually clear the coverage detector's
  // thresholds — a small, inventoried-but-uninvoked server that the
  // coverage detector skips would otherwise become a blind spot.
  const coverageReportedServers = new Set(
    mcpCoverage
      .filter(
        (c) =>
          c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS &&
          c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS &&
          c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
      )
      .map((c) => c.server),
  );

  const now = Date.now();
  const unused: string[] = [];
  for (const entry of configured.values()) {
    if (calledServers.has(entry.normalized)) continue;
    if (coverageReportedServers.has(entry.normalized)) continue;
    if (entry.mtime > 0 && now - entry.mtime < MCP_NEW_CONFIG_GRACE_MS)
      continue;
    unused.push(entry.original);
  }

  if (unused.length === 0) return null;

  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0);
  const schemaTokensPerSession =
    unused.length * TOOLS_PER_MCP_SERVER * TOKENS_PER_MCP_TOOL;
  const tokensSaved = schemaTokensPerSession * Math.max(totalSessions, 1);

  return {
    title: `${unused.length} MCP server${unused.length > 1 ? "s" : ""} configured but never used`,
    explanation: `Never called in this period: ${unused.join(", ")}. Each server loads ~${TOOLS_PER_MCP_SERVER * TOKENS_PER_MCP_TOOL} tokens of tool schema into every session.`,
    impact: unused.length >= UNUSED_MCP_HIGH_THRESHOLD ? "high" : "medium",
    tokensSaved,
    fix: {
      type: "command",
      label: `Remove unused server${unused.length > 1 ? "s" : ""}:`,
      text: unused.map((s) => `claude mcp remove ${s}`).join("\n"),
    },
  };
}
