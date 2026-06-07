import { readdir, stat } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";

import { getShortModelName } from "../models.js";
import { openDatabase } from "../sqlite.js";
import { readConfig } from "../config.js";
import type {
  Provider,
  SessionParser,
  SessionSource,
  ParsedProviderCall,
} from "./types.js";
import { readSessionFile } from "../fs-utils.js";
import { isPositiveNumber, safeNumber } from "../parser.js";

type AgentTrajectory<T extends Step> = {
  schema_version: string;
  session_id?: string;
  agent: Agent;
  steps: T[];
};

type Agent = {
  name: string;
  version: string;
  model_name?: string;
};

type ToolCall = {
  tool_call_id: string;
  function_name: string;
  arguments: unknown;
};

type DevinMetadata = {
  created_at?: string;
  committed_acu_cost?: number;
  generation_model?: string;
  is_user_input?: boolean;
  num_tokens?: number;
  request_id?: string;
  finish_reason?: string;
  metrics?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
    tokens_per_sec?: number;
    total_time_ms?: number;
    ttft_ms?: number;
    tpot_ms?: number;
  };
};

type Step = {
  step_id: number;
  source: string;
  model_name?: string;
  message: string;
  tool_calls?: Array<ToolCall>;
};

type DevinStep = Step & { metadata?: DevinMetadata };

type DevinAgentTrajectory = AgentTrajectory<DevinStep>;

type DevinSessionMetadata = {
  id: string;
  workingDirectory: string;
  model: string;
  title?: string;
  createdAt: string;
  lastActivityAt: string;
  hidden: boolean;
};

type DevinUsage = {
  committedAcuCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

const DEFAULT_DEVIN_CLI_DIR = join(
  homedir(),
  ".local",
  "share",
  "devin",
  "cli",
);

const DEFAULT_MODEL_NAME = "devin";
const DEVIN_PROVIDER_NAME = "devin";
const DEVIN_PROVIDER_DISPLAY_NAME = "Devin";
const DEVIN_TRANSCRIPTS_SUBDIR = "transcripts";
const DEVIN_SESSIONS_DB = "sessions.db";

function parseTranscript(raw: string): DevinAgentTrajectory | null {
  try {
    return JSON.parse(raw) as DevinAgentTrajectory;
  } catch {
    return null;
  }
}

function parseNumericTimestamp(value: number): string {
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(millis).toISOString();
}

function getUsage(
  metadata: DevinMetadata | undefined | null,
): DevinUsage | null {
  if (!metadata) return null;
  const metrics = metadata.metrics;

  const hasAnyUsage = [
    metadata.committed_acu_cost,
    metrics?.input_tokens,
    metrics?.output_tokens,
    metrics?.cache_creation_tokens,
    metrics?.cache_read_tokens,
  ].some((x) => isPositiveNumber(x));

  if (!hasAnyUsage) return null;

  return {
    committedAcuCost: safeNumber(metadata.committed_acu_cost),
    inputTokens: safeNumber(metrics?.input_tokens),
    outputTokens: safeNumber(metrics?.output_tokens),
    cacheCreationInputTokens: safeNumber(metrics?.cache_creation_tokens),
    cacheReadInputTokens: safeNumber(metrics?.cache_read_tokens),
  };
}

function getSessionId(
  source: SessionSource,
  transcript: DevinAgentTrajectory,
): string {
  const fromTranscript = transcript.session_id?.trim();
  return fromTranscript || basename(source.path, ".json");
}

function projectNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[/\\]+$/, "");
  return normalized.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function getProjectName(
  source: SessionSource,
  session: DevinSessionMetadata | null,
): string {
  if (session?.workingDirectory)
    return projectNameFromPath(session.workingDirectory);
  if (session?.title) return session.title;
  return source.project;
}

function getProjectPath(
  session: DevinSessionMetadata | null,
): string | undefined {
  return session?.workingDirectory;
}

function getTimestamp(
  step: DevinStep,
  session: DevinSessionMetadata | null,
): string | undefined {
  return [
    step.metadata?.created_at,
    session?.lastActivityAt,
    session?.createdAt,
  ]
    .filter(Boolean)
    .shift();
}

function getModelName(
  transcript: DevinAgentTrajectory,
  step: DevinStep,
  session: DevinSessionMetadata | null,
): string {
  return (
    [
      step.metadata?.generation_model,
      step.model_name,
      transcript.agent?.model_name,
      session?.model,
    ]
      .filter(Boolean)
      .shift() || DEFAULT_MODEL_NAME
  );
}

function getToolNames(step: DevinStep): string[] {
  return (step.tool_calls ?? []).map((call) => call.function_name);
}

function getFirstUserMessageBeforeStep(
  steps: DevinStep[],
  index: number,
): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step?.metadata?.is_user_input) continue;
    const message = step.message?.trim();
    if (message) return message;
  }
  return null;
}

function loadSessionMetadata(
  dbPath: string,
): Map<string, DevinSessionMetadata> {
  const sessions = new Map<string, DevinSessionMetadata>();
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(dbPath);
    const rows = db.query<{
      id: string;
      working_directory: string;
      model: string;
      title: string | null;
      created_at: number;
      last_activity_at: number;
      hidden: number;
    }>(
      `SELECT id, working_directory, model, title, created_at, last_activity_at, hidden
       FROM sessions`,
    );
    for (const row of rows) {
      if (!row.id) continue;
      sessions.set(row.id, {
        id: row.id,
        workingDirectory: row.working_directory,
        model: row.model,
        title: row.title ?? undefined,
        createdAt: parseNumericTimestamp(row.created_at),
        lastActivityAt: parseNumericTimestamp(row.last_activity_at),
        hidden: !!row.hidden,
      });
    }
  } catch {
    return sessions;
  } finally {
    db?.close();
  }
  return sessions;
}

async function getCostFactor(): Promise<number | null> {
  const configRate = (await readConfig()).devin?.acuUsdRate;
  return isPositiveNumber(configRate) ? configRate : null;
}

class DevinSessionParser implements SessionParser {
  constructor(
    private source: SessionSource,
    private seenKeys: Set<string>,
    private sessionMetadata: Map<string, DevinSessionMetadata>,
  ) {}

  async *parse(): AsyncGenerator<ParsedProviderCall> {
    const raw = await readSessionFile(this.source.path);
    if (!raw) return;

    const transcript = parseTranscript(raw);
    if (!transcript?.steps) return;

    const sessionId = getSessionId(this.source, transcript);
    const session = this.sessionMetadata.get(sessionId) ?? null;
    if (session?.hidden) return;

    const project = getProjectName(this.source, session);
    const projectPath = getProjectPath(session);
    const costFactor = await getCostFactor();
    if (costFactor === null) return;

    for (let index = 0; index < transcript.steps.length; index++) {
      const step = transcript.steps[index];
      if (step.metadata?.is_user_input) continue;

      const usage = getUsage(step.metadata);
      if (!usage) continue;

      const timestamp = getTimestamp(step, session) ?? "";

      const deduplicationKey = `devin:${sessionId}:${step.step_id}`;

      if (this.seenKeys.has(deduplicationKey)) continue;
      this.seenKeys.add(deduplicationKey);

      const model = getModelName(transcript, step, session);
      const tools = getToolNames(step);
      const userMessage =
        getFirstUserMessageBeforeStep(transcript.steps, index) ?? "";

      yield {
        provider: DEVIN_PROVIDER_NAME,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cachedInputTokens: usage.cacheReadInputTokens,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: usage.committedAcuCost * costFactor,
        tools,
        bashCommands: [],
        timestamp,
        speed: "standard",
        deduplicationKey,
        userMessage,
        sessionId,
        project,
        projectPath,
      };
    }
  }
}

export function createDevinProvider(cliDir: string): Provider {
  const sessionsDbPath = join(cliDir, DEVIN_SESSIONS_DB);
  let sessionMetadata: Map<string, DevinSessionMetadata> | null = null;

  const getSessionMetadata = () => {
    if (!sessionMetadata) sessionMetadata = loadSessionMetadata(sessionsDbPath);
    return sessionMetadata;
  };

  return {
    name: DEVIN_PROVIDER_NAME,
    displayName: DEVIN_PROVIDER_DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model);
    },

    toolDisplayName(rawTool: string): string {
      return rawTool;
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if ((await getCostFactor()) === null) return [];

      const transcriptsDir = join(cliDir, DEVIN_TRANSCRIPTS_SUBDIR);
      const entries = await readdir(transcriptsDir).catch(() => []);
      const metadata = getSessionMetadata();
      const sources: SessionSource[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;

        const filePath = join(transcriptsDir, entry);
        const pathStats = await stat(filePath).catch(() => null);

        if (!pathStats?.isFile()) continue;

        const session = metadata.get(basename(filePath, ".json")) ?? null;
        if (session?.hidden) continue;

        const tmpSource: SessionSource = {
          path: filePath,
          project: DEVIN_PROVIDER_NAME,
          provider: DEVIN_PROVIDER_NAME,
        };

        const project = getProjectName(tmpSource, session);

        sources.push({
          path: filePath,
          project,
          provider: DEVIN_PROVIDER_NAME,
        });
      }

      return sources;
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
    ): SessionParser {
      return new DevinSessionParser(source, seenKeys, getSessionMetadata());
    },
  };
}

export const devin = createDevinProvider(DEFAULT_DEVIN_CLI_DIR);
