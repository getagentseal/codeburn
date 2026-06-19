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
  schema_version?: string;
  session_id?: string;
  trajectory_id?: string;
  agent?: Agent;
  steps?: T[];
};

type Agent = {
  name?: string;
  version?: string;
  model_name?: string;
  tool_definitions?: unknown;
};

type ToolCall = {
  tool_call_id?: string;
  function_name?: string;
  function?: {
    name?: string;
  };
  arguments: unknown;
};

type DevinMetrics = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  total_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  extra?: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

type DevinMetadata = {
  created_at?: string;
  committed_acu_cost?: number;
  committed_credit_cost?: number;
  generation_model?: string;
  is_user_input?: boolean;
  num_tokens?: number;
  request_id?: string;
  finish_reason?: string;
  metrics?: DevinMetrics;
};

type DevinStepExtra = {
  committed_acu_cost?: number;
  committed_credit_cost?: number;
  generation_model?: string;
};

type Step = {
  step_id?: number | string;
  source?: string;
  timestamp?: string;
  model_name?: string;
  message?: unknown;
  metrics?: DevinMetrics;
  metadata?: DevinMetadata;
  extra?: DevinStepExtra;
  tool_calls?: Array<ToolCall>;
};

type DevinStep = Step;

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
const DEVIN_CREDITS_PER_ACU = 10_000;

function parseTranscript(raw: string): DevinAgentTrajectory | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as DevinAgentTrajectory;
  } catch {
    return null;
  }
}

function parseNumericTimestamp(value: number): string {
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(millis).toISOString();
}

function normalizeMessageText(message: unknown): string {
  if (typeof message === "string") return message.trim();

  if (Array.isArray(message)) {
    return message
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      })
      .map((text) => text.trim())
      .filter(Boolean)
      .join(" ");
  }

  if (message && typeof message === "object") {
    const text = (message as Record<string, unknown>).text;
    if (typeof text === "string") return text.trim();
  }

  return "";
}

function getCommittedAcuCost(step: DevinStep): number {
  const metadataAcuCost = safeNumber(step.metadata?.committed_acu_cost);
  if (isPositiveNumber(metadataAcuCost)) return metadataAcuCost;

  const extraAcuCost = safeNumber(step.extra?.committed_acu_cost);
  if (isPositiveNumber(extraAcuCost)) return extraAcuCost;

  const metadataCreditCost = safeNumber(step.metadata?.committed_credit_cost);
  if (isPositiveNumber(metadataCreditCost)) {
    return metadataCreditCost / DEVIN_CREDITS_PER_ACU;
  }

  const extraCreditCost = safeNumber(step.extra?.committed_credit_cost);
  if (isPositiveNumber(extraCreditCost)) {
    return extraCreditCost / DEVIN_CREDITS_PER_ACU;
  }

  return 0;
}

function getUsage(step: DevinStep): DevinUsage | null {
  const metrics = step.metrics ?? step.metadata?.metrics;
  const committedAcuCost = getCommittedAcuCost(step);

  const cacheCreationInputTokens = safeNumber(
    metrics?.cache_creation_tokens ??
      metrics?.cache_creation_input_tokens ??
      metrics?.extra?.cache_creation_input_tokens,
  );

  const cacheReadInputTokens = safeNumber(
    metrics?.cache_read_tokens ??
      metrics?.cache_read_input_tokens ??
      metrics?.cached_tokens ??
      metrics?.extra?.cache_read_input_tokens,
  );

  const promptTokens = safeNumber(
    metrics?.prompt_tokens ?? metrics?.total_input_tokens,
  );

  let inputTokens = safeNumber(metrics?.input_tokens);
  if (inputTokens === 0 && promptTokens > 0) {
    inputTokens = Math.max(
      0,
      promptTokens - cacheReadInputTokens - cacheCreationInputTokens,
    );
  }

  const outputTokens = safeNumber(
    metrics?.output_tokens ?? metrics?.completion_tokens,
  );

  const hasAnyUsage = [
    committedAcuCost,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  ].some((x) => isPositiveNumber(x));

  if (!hasAnyUsage) return null;

  return {
    committedAcuCost,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  };
}

function isUserInputStep(step: DevinStep): boolean {
  return step.metadata?.is_user_input === true || step.source === "user";
}

function getSessionId(
  source: SessionSource,
  transcript: DevinAgentTrajectory,
): string {
  const fromTranscript = transcript.session_id?.trim();
  if (fromTranscript) return fromTranscript;

  const fromTrajectoryId = transcript.trajectory_id?.trim();
  if (fromTrajectoryId) return fromTrajectoryId;

  return basename(source.path, ".json");
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
    step.timestamp,
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
      step.extra?.generation_model,
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
  const tools: string[] = [];
  const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
  for (const call of toolCalls) {
    const toolName = call.function_name ?? call.function?.name;
    if (toolName) tools.push(toolName);
  }
  return tools;
}

function getFirstUserMessageBeforeStep(
  steps: DevinStep[],
  index: number,
): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step || !isUserInputStep(step)) continue;
    const message = normalizeMessageText(step.message);
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
    if (!transcript?.steps || !Array.isArray(transcript.steps)) return;

    const sessionId = getSessionId(this.source, transcript);
    const session = this.sessionMetadata.get(sessionId) ?? null;
    if (session?.hidden) return;

    const project = getProjectName(this.source, session);
    const projectPath = getProjectPath(session);
    const costFactor = await getCostFactor();
    if (costFactor === null) return;

    for (let index = 0; index < transcript.steps.length; index++) {
      const step = transcript.steps[index];
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      if (isUserInputStep(step)) continue;

      const usage = getUsage(step);
      if (!usage) continue;

      const timestamp = getTimestamp(step, session) ?? "";
      const stepId = `${step.step_id ?? index + 1}`;
      const deduplicationKey = `devin:${sessionId}:${stepId}`;

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
