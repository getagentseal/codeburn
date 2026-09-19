import { readdir, stat } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";

import { calculateCost, getShortModelName } from "../models.js";
import { openDatabase } from "../sqlite.js";
import type {
  ProbeRoot,
  Provider,
  SessionParser,
  SessionSource,
  ParsedProviderCall,
} from "./types.js";
import { readSessionFile } from "../fs-utils.js";
import { isPositiveNumber, safeNumber } from "../parser.js";

type AgentTrajectory<StepType extends Step = Step, AgentExtra = unknown> = {
  schema_version: string;
  session_id?: string;
  agent: Agent<AgentExtra>;
  steps: StepType[];
  final_metrics?: FinalMetrics;
};

type FinalMetrics = {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_steps?: number;
};

type DevinAgentExtra = {
  backend?: string;
  permission_mode?: string;
};

type Agent<Extra = unknown> = {
  name: string;
  version: string;
  model_name?: string;
  tool_definitions?: unknown;
  extra?: Extra;
};

type ToolCall = {
  tool_call_id: string;
  function_name: string;
  arguments: unknown;
};

type DevinMetadata = {
  created_at?: string;
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

type ContentPart = ContentPartText | ContentPartImage;

type ContentPartText = {
  type: "text";
  text: string;
};

type ContentPartImage = {
  type: "image";
  source: ImageSource;
};

function isTextContentPart(
  contentPart: ContentPart,
): contentPart is ContentPartText {
  return contentPart.type === "text";
}

type ImageSource = {
  media_type: string;
  path: string;
};

type Step<StepExtra = unknown, MetricsExtra = unknown> = {
  step_id: number;
  timestamp?: string;
  source: string;
  model_name?: string;
  message: string | Array<ContentPart>;
  tool_calls?: Array<ToolCall>;
  extra?: StepExtra;
  observation?: Observation;
  metrics?: Metrics<MetricsExtra>;
};

type DevinTelemetry = {
  source?: string;
  operation?: string;
};

type DevinStepExtra = {
  generation_model?: string;
  telemetry?: DevinTelemetry;
};

type Observation = {
  results: Array<ObservationResult>;
};

type ObservationResult = {
  source_call_id?: string;
  content?: string | Array<ContentPart>;
};

type Metrics<Extra = unknown> = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  extra?: Extra;
};

type DevinMetricsExtra = {
  cache_creation_input_tokens?: number;
};

type DevinStep = Step<DevinStepExtra, DevinMetricsExtra> & {
  metadata?: DevinMetadata;
};

type DevinAgentTrajectory = AgentTrajectory<DevinStep, DevinAgentExtra>;

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
const DEVIN_EFFORT_TIERS = new Set(["xhigh", "high", "medium", "low"]);

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

function hasAnyTokenField(
  metrics: Metrics<DevinMetricsExtra> | null | undefined,
): boolean {
  if (!metrics) return false;
  return [
    metrics.prompt_tokens,
    metrics.completion_tokens,
    metrics.cached_tokens,
    metrics.extra?.cache_creation_input_tokens,
  ].some((value) => value != null);
}

function getMetricsFromStep(
  step: DevinStep,
): Metrics<DevinMetricsExtra> | null {
  // Prefer step.metrics (standard ATIF v1.7) only when it actually carries
  // token fields; a present-but-empty metrics object must not shadow the
  // legacy metadata.metrics location.
  if (hasAnyTokenField(step.metrics)) {
    return step.metrics ?? null;
  }

  if (step.metadata) {
    return getDevinMetricsFromMetadata(step.metadata);
  }

  return step.metrics ?? null;
}

function getDevinMetricsFromMetadata(
  metadata: DevinMetadata,
): Metrics<DevinMetricsExtra> {
  return {
    prompt_tokens: metadata.metrics?.input_tokens,
    completion_tokens: metadata.metrics?.output_tokens,
    cached_tokens: metadata.metrics?.cache_read_tokens,
    extra: {
      cache_creation_input_tokens: metadata.metrics?.cache_creation_tokens,
    },
  };
}

function getUsage(step: DevinStep): DevinUsage | null {
  const metrics = getMetricsFromStep(step);

  const hasAnyUsage = [
    metrics?.prompt_tokens,
    metrics?.completion_tokens,
    metrics?.extra?.cache_creation_input_tokens,
    metrics?.cached_tokens,
  ].some((x) => isPositiveNumber(x));

  if (!hasAnyUsage) return null;

  const cacheReadInputTokens = safeNumber(metrics?.cached_tokens);

  return {
    // Devin reports OpenAI-style prompt_tokens, with the cached tokens counted
    // inside it; Anthropic semantics (what calculateCost expects) keep them
    // apart, so the cached share is carved out instead of billed twice.
    inputTokens: Math.max(0, safeNumber(metrics?.prompt_tokens) - cacheReadInputTokens),
    outputTokens: safeNumber(metrics?.completion_tokens),
    cacheCreationInputTokens: safeNumber(
      metrics?.extra?.cache_creation_input_tokens,
    ),
    cacheReadInputTokens,
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

function firstPresentString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function getFriendlyGptName(model: string): string {
  const shortName = getShortModelName(model);
  const match = model.match(/^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/);
  if (!match) return shortName;

  const suffixParts = match[2]?.split("-").filter(Boolean) ?? [];
  // A purely numeric suffix token means this is a dated snapshot id such as
  // gpt-4-1106-preview, not a clean version+word id. Fabricating a friendly
  // name here would mislabel the date as text (e.g. "GPT-4 1106 Preview"), so
  // defer to getShortModelName, which passes unknown snapshots through raw.
  if (suffixParts.some((part) => /^\d+$/.test(part))) return shortName;

  const suffix = suffixParts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  const reconstructed = `GPT-${match[1]}${suffix ? ` ${suffix}` : ""}`;
  if (shortName !== model && (!suffix || shortName !== `GPT-${match[1]}`)) {
    return shortName;
  }

  return reconstructed;
}

// Devin minor versions are always a single digit (gpt-5-3-codex). Restrict the
// dash-to-dot rewrite to a single-digit minor at a token boundary so a dated
// snapshot like gpt-4-1106-preview is not misread as version 4.1106.
function normalizeDevinGptId(model: string): string {
  return model.replace(/^gpt-(\d+)-(\d)(?=-|$)/, "gpt-$1.$2");
}

function getDevinDisplayModelName(
  generationModel: string | undefined,
  modelName: string,
): string {
  if (!generationModel || /^MODEL_/.test(generationModel)) {
    return getShortModelName(modelName);
  }

  if (generationModel.startsWith("gpt-")) {
    const normalized = normalizeDevinGptId(generationModel);
    const effortMatch = normalized.match(/-([^-]+)$/);
    const effort = effortMatch && DEVIN_EFFORT_TIERS.has(effortMatch[1]!)
      ? effortMatch[1]
      : undefined;
    const base = effort ? normalized.slice(0, -(effort.length + 1)) : normalized;
    const friendlyBase = getFriendlyGptName(base);
    return effort ? `${friendlyBase} (${effort})` : friendlyBase;
  }

  return getShortModelName(generationModel);
}

function getModels(
  transcript: DevinAgentTrajectory,
  step: DevinStep,
  session: DevinSessionMetadata | null,
): { pricingModel: string; displayModel: string } {
  const generationModel = firstPresentString(
    step.metadata?.generation_model,
    step.extra?.generation_model,
  );
  const modelName = firstPresentString(
    step.model_name,
    transcript.agent?.model_name,
    session?.model,
  ) ?? DEFAULT_MODEL_NAME;

  const pricingModel =
    !generationModel || /^MODEL_/.test(generationModel)
      ? modelName
      : normalizeDevinGptId(generationModel);

  return {
    pricingModel,
    displayModel: getDevinDisplayModelName(generationModel, modelName),
  };
}

function getToolNames(step: DevinStep): string[] {
  return (step.tool_calls ?? []).map((call) => call.function_name);
}

function normalizeContentPartMessage(contentPart: ContentPart) {
  if (isTextContentPart(contentPart)) {
    return contentPart.text;
  } else {
    return contentPart.source.path;
  }
}

function normalizeStepMessage(message: string | Array<ContentPart>): string {
  if (Array.isArray(message)) {
    return message.map((x) => normalizeContentPartMessage(x).trim()).join(" ");
  }
  return message.trim();
}

// Real transcripts mark the user's turn with source "user" and leave
// is_user_input unset; older ones do the opposite.
function isUserStep(step: DevinStep): boolean {
  return step.metadata?.is_user_input === true || step.source === "user";
}

function getFirstUserMessageBeforeStep(
  steps: DevinStep[],
  index: number,
): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step || !isUserStep(step)) continue;
    const message = step.message
      ? normalizeStepMessage(step.message)
      : undefined;
    if (message) return message;
  }
  return null;
}

// Devin only fills sessions.title once it has summarised the session, so an
// unsummarised session falls back to what the user actually typed first.
function loadFirstPrompts(db: ReturnType<typeof openDatabase>): Map<string, string> {
  const prompts = new Map<string, string>();
  try {
    const rows = db.query<{ session_id: string; content: string }>(
      `SELECT session_id, content FROM prompt_history ORDER BY id`,
    );
    for (const row of rows) {
      const content = row.content?.trim();
      if (!row.session_id || !content || prompts.has(row.session_id)) continue;
      prompts.set(row.session_id, content);
    }
  } catch {
    // Older Devin builds have no prompt_history table.
  }
  return prompts;
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
    const firstPrompts = loadFirstPrompts(db);
    for (const row of rows) {
      if (!row.id) continue;
      sessions.set(row.id, {
        id: row.id,
        workingDirectory: row.working_directory,
        model: row.model,
        title: row.title?.trim() || firstPrompts.get(row.id),
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

    for (let index = 0; index < transcript.steps.length; index++) {
      const step = transcript.steps[index];
      if (isUserStep(step)) continue;

      const usage = getUsage(step);
      if (!usage) continue;

      const timestamp = getTimestamp(step, session) ?? "";

      const deduplicationKey = `devin:${sessionId}:${step.step_id}`;

      if (this.seenKeys.has(deduplicationKey)) continue;
      this.seenKeys.add(deduplicationKey);

      const { pricingModel, displayModel } = getModels(transcript, step, session);
      const tools = getToolNames(step);
      const userMessage =
        getFirstUserMessageBeforeStep(transcript.steps, index) ??
        session?.title ??
        "";

      yield {
        provider: DEVIN_PROVIDER_NAME,
        model: displayModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cachedInputTokens: usage.cacheReadInputTokens,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: calculateCost(
          pricingModel,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheCreationInputTokens,
          usage.cacheReadInputTokens,
          0,
        ),
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

function resolveDevinCliDir(override?: string): string {
  return override && override.trim() ? override : DEFAULT_DEVIN_CLI_DIR;
}

function getDevinDiscoveryRoots(cliDir: string): {
  transcriptsDir: string;
  sessionsDbPath: string;
} {
  return {
    transcriptsDir: join(cliDir, DEVIN_TRANSCRIPTS_SUBDIR),
    sessionsDbPath: join(cliDir, DEVIN_SESSIONS_DB),
  };
}

export function createDevinProvider(cliDir?: string): Provider {
  const resolvedCliDir = resolveDevinCliDir(cliDir);
  const { transcriptsDir, sessionsDbPath } =
    getDevinDiscoveryRoots(resolvedCliDir);
  let sessionMetadata: Map<string, DevinSessionMetadata> | null = null;

  const getSessionMetadata = () => {
    if (!sessionMetadata) sessionMetadata = loadSessionMetadata(sessionsDbPath);
    return sessionMetadata;
  };

  return {
    name: DEVIN_PROVIDER_NAME,
    displayName: DEVIN_PROVIDER_DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return model;
    },

    toolDisplayName(rawTool: string): string {
      return rawTool;
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [
        { path: transcriptsDir, label: "transcripts" },
        { path: sessionsDbPath, label: "sessions.db" },
      ];
    },

    async discoverSessions(): Promise<SessionSource[]> {
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
