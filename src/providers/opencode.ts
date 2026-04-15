import { statSync } from "fs";
import Database from "better-sqlite3";
import { basename, join } from "path";
import { homedir } from "os";

import { calculateCost } from "../models.js";
import type {
  Provider,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
} from "./types.js";

const modelDisplayNames: Record<string, string> = {
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-5": "Opus 4.5",
  "claude-opus-4-1": "Opus 4.1",
  "claude-opus-4": "Opus 4",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-sonnet-4": "Sonnet 4",
  "claude-3-7-sonnet": "Sonnet 3.7",
  "claude-3-5-sonnet": "Sonnet 3.5",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-3-5-haiku": "Haiku 3.5",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-5": "GPT-5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
};

const toolNameMap: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  glob: "Glob",
  grep: "Grep",
  task: "Agent",
  fetch: "WebFetch",
  search: "WebSearch",
  code: "CodeSearch",
  todo: "TodoWrite",
  skill: "Skill",
  patch: "Patch",
  question: "Question",
  lsp: "LSP",
  plan: "Plan",
  invalid: "Invalid",
};

function getDbPath(dataDir?: string): string {
  const base =
    dataDir ??
    process.env["XDG_DATA_HOME"] ??
    join(homedir(), ".local", "share");
  return join(base, "opencode", "opencode.db");
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const parts = source.path.split(":");
      const sessionId = parts[parts.length - 1]!;
      const dbPath = parts.slice(0, -1).join(":");

      let db: Database.Database;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        return;
      }

      try {
        const messages = db
          .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
          )
          .all(sessionId) as Array<{
          id: string;
          time_created: number;
          data: string;
        }>;

        const parts = db
          .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id",
          )
          .all(sessionId) as Array<{ message_id: string; data: string }>;

        const partsByMsg = new Map<
          string,
          Array<{ type: string; text?: string; tool?: string }>
        >();
        for (const part of parts) {
          try {
            const parsed = JSON.parse(part.data);
            if (!partsByMsg.has(part.message_id)) {
              partsByMsg.set(part.message_id, []);
            }
            partsByMsg.get(part.message_id)!.push(parsed);
          } catch {
            // skip invalid JSON
          }
        }

        let currentUserMessage = "";

        for (const msg of messages) {
          let data: any;
          try {
            data = JSON.parse(msg.data);
          } catch {
            continue;
          }

          if (data.role === "user") {
            const textParts = (partsByMsg.get(msg.id) ?? [])
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text ?? "")
              .filter(Boolean);
            if (textParts.length > 0) {
              currentUserMessage = textParts.join(" ");
            }
            continue;
          }

          if (data.role === "assistant") {
            const tokens = {
              input: data.tokens?.input ?? 0,
              output: data.tokens?.output ?? 0,
              reasoning: data.tokens?.reasoning ?? 0,
              cacheRead: data.tokens?.cache?.read ?? 0,
              cacheWrite: data.tokens?.cache?.write ?? 0,
            };

            const allZero =
              tokens.input === 0 &&
              tokens.output === 0 &&
              tokens.reasoning === 0 &&
              tokens.cacheRead === 0 &&
              tokens.cacheWrite === 0;
            if (allZero && (data.cost ?? 0) === 0) {
              continue;
            }

            const tools = (partsByMsg.get(msg.id) ?? [])
              .filter((p: any) => p.type === "tool")
              .map((p: any) => p.tool ?? "")
              .filter(Boolean);

            const dedupKey = `opencode:${sessionId}:${msg.id}`;
            if (seenKeys.has(dedupKey)) {
              continue;
            }
            seenKeys.add(dedupKey);

            const model = data.modelID ?? "unknown";
            let costUSD = calculateCost(
              model,
              tokens.input,
              tokens.output + tokens.reasoning,
              tokens.cacheWrite,
              tokens.cacheRead,
              0,
            );

            if (costUSD === 0 && (data.cost ?? 0) > 0) {
              costUSD = data.cost;
            }

            const timestamp = new Date(msg.time_created).toISOString();

            yield {
              provider: "opencode",
              model,
              inputTokens: tokens.input,
              outputTokens: tokens.output,
              cacheCreationInputTokens: tokens.cacheWrite,
              cacheReadInputTokens: tokens.cacheRead,
              cachedInputTokens: 0,
              reasoningTokens: tokens.reasoning,
              webSearchRequests: 0,
              costUSD,
              tools,
              timestamp,
              speed: "standard",
              deduplicationKey: dedupKey,
              userMessage: currentUserMessage,
              sessionId,
            };
          }
        }
      } finally {
        db.close();
      }
    },
  };
}

export function createOpenCodeProvider(dataDir?: string): Provider {
  const dbPath = getDbPath(dataDir);

  return {
    name: "opencode",
    displayName: "OpenCode",

    modelDisplayName(model: string): string {
      const stripped = model
        .replace(/^[^/]+\//, "")
        .replace(/@.*$/, "")
        .replace(/-\d{8}$/, "");
      return modelDisplayNames[stripped] ?? stripped;
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool;
    },

    async discoverSessions(): Promise<SessionSource[]> {
      try {
        statSync(dbPath);
      } catch {
        return [];
      }

      let db: Database.Database;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        return [];
      }

      try {
        const rows = db
          .prepare(
            "SELECT id, directory, title, time_created FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC",
          )
          .all() as Array<{
          id: string;
          directory: string;
          title: string;
          time_created: number;
        }>;

        return rows.map((row) => ({
          path: `${dbPath}:${row.id}`,
          project: row.directory ? basename(row.directory) : row.title,
          provider: "opencode",
        }));
      } catch {
        return [];
      } finally {
        db.close();
      }
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
    ): SessionParser {
      return createParser(source, seenKeys);
    },
  };
}

export const opencode = createOpenCodeProvider();
