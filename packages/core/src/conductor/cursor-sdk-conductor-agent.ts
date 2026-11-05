import {
  Agent,
  AuthenticationError,
  CursorAgentError,
  Cursor,
  type AgentOptions,
  type McpServerConfig,
  type ModelListItem,
  type ModelSelection,
  type SDKAgent,
  type ToolName,
} from '@cursor/sdk';
import {
  ensureCursorSdkProxy,
  ensureCursorSdkRipgrepPath,
} from './configure-cursor-sdk-env.js';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
  ConductorAgentUsage,
  ConductorSendCallbacks,
  ConductorSendResult,
  ConductorTokenUsage,
} from './conductor-agent.js';
import { resolveConductorApiKey } from './conductor-auth.js';
import { formatConductorToolName } from './conductor-tool-name.js';
import { toSdkCustomTools } from './conductor-tool-sdk-adapter.js';
import { resolveConductorModelId } from './resolve-conductor-model-id.js';

/** Cursor built-in tools that can directly inspect or modify a repository. */
const CURSOR_CODING_TOOLS: ToolName[] = [
  'shell',
  'read',
  'edit',
  'write',
  'grep',
  'glob',
  'ls',
  'delete',
  'readLints',
  'semSearch',
  'applyAgentDiff',
  'task',
];

/** Cursor SDK implementation of the backend-neutral conductor interface. */
export class CursorSdkConductorAgent implements ConductorAgent {
  private activeRun?: Awaited<ReturnType<SDKAgent['send']>>;
  private pendingRun?: Promise<Awaited<ReturnType<SDKAgent['send']>>>;

  private constructor(private readonly agent: SDKAgent) {}

  get agentId(): string {
    return this.agent.agentId;
  }

  static async create(
    options: ConductorAgentCreateOptions,
  ): Promise<CursorSdkConductorAgent> {
    ensureCursorSdkEnv();
    const agent = await Agent.create(await buildAgentOptions(options));
    return new CursorSdkConductorAgent(agent);
  }

  static async resume(
    agentId: string,
    options: ConductorAgentCreateOptions,
  ): Promise<CursorSdkConductorAgent> {
    ensureCursorSdkEnv();
    const agent = await Agent.resume(agentId, await buildAgentOptions(options));
    return new CursorSdkConductorAgent(agent);
  }

  async send(
    prompt: string,
    callbacks?: ConductorSendCallbacks,
  ): Promise<ConductorSendResult> {
    try {
      const pendingRunId = { value: '' };
      const pendingRun = this.agent.send(prompt, {
        onDelta: ({ update }) => {
          if (update.type === 'tool-call-started') {
            callbacks?.onToolCallStarted?.({
              runId: pendingRunId.value,
              tool: formatConductorToolName(update.toolCall),
              callId: update.callId,
            });
          }
        },
      });
      this.pendingRun = pendingRun;
      let run: Awaited<ReturnType<SDKAgent['send']>>;
      try {
        run = await pendingRun;
      } finally {
        if (this.pendingRun === pendingRun) {
          this.pendingRun = undefined;
        }
      }
      pendingRunId.value = run.id;
      this.activeRun = run;
      try {
        const result = await run.wait();
        return {
          runId: run.id,
          status: result.status,
          result: typeof result.result === 'string' ? result.result : undefined,
          error: result.error
            ? { message: result.error.message, code: result.error.code }
            : undefined,
          usage: result.usage
            ? toConductorTokenUsage(result.usage)
            : run.usage
              ? toConductorTokenUsage(run.usage)
              : undefined,
          modelId: result.model?.id,
        };
      } finally {
        if (this.activeRun === run) {
          this.activeRun = undefined;
        }
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return {
          runId: '',
          status: 'error',
          error: { message: error.message, code: error.code },
        };
      }
      if (error instanceof CursorAgentError) {
        throw new Error(
          `Conductor startup failed: ${error.message} (retryable=${error.isRetryable})`,
        );
      }
      throw error;
    }
  }

  async cancel(): Promise<void> {
    let run = this.activeRun;
    if (!run && this.pendingRun) {
      await this.pendingRun;
      run = this.activeRun;
    }
    if (!run) return;
    if (!run.supports('cancel')) {
      throw new Error('Cursor SDK run does not support cancellation.');
    }
    await run.cancel();
  }

  async reload(): Promise<void> {
    await this.agent.reload();
  }

  async getUsage(): Promise<ConductorAgentUsage> {
    const usage = await this.agent.getUsage();
    return usage.cost
      ? {
          cost: {
            rawCostCents: usage.cost.rawCostCents,
            chargedCents: usage.cost.chargedCents,
          },
        }
      : {};
  }

  /** Cursor SDK has no system-prompt API; the initial user send remains the SDK path. */
  async setSystemPrompt(_systemPrompt: string): Promise<void> {}

  async close(): Promise<void> {
    await this.agent[Symbol.asyncDispose]();
  }
}

/** Create the default Cursor SDK conductor backend factory. */
export function createCursorSdkConductorAgentFactory(): ConductorAgentFactory {
  return {
    create: (options) => CursorSdkConductorAgent.create(options),
    resume: (agentId, options) => CursorSdkConductorAgent.resume(agentId, options),
  };
}

let cursorSdkEnvReady = false;

function ensureCursorSdkEnv(): void {
  if (cursorSdkEnvReady) {
    return;
  }
  cursorSdkEnvReady = true;
  ensureCursorSdkProxy();
  ensureCursorSdkRipgrepPath();
}

async function buildAgentOptions(
  options: ConductorAgentCreateOptions,
): Promise<AgentOptions> {
  const apiKey = resolveConductorApiKey(options.apiKey);
  const modelId = resolveConductorModelId(options.modelId);
  const model: ModelSelection = { id: modelId };
  if (options.reasoning !== undefined) {
    if (!options.reasoning.trim()) {
      throw new Error('Cursor conductor reasoning must be a non-empty string.');
    }
    const models = await Cursor.models.list(
      apiKey !== undefined ? { apiKey } : {},
    );
    model.params = resolveCursorReasoningParameters(
      models,
      modelId,
      options.reasoning,
    );
  }

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    model,
    mode: 'agent',
    ...(options.builtinTools === false
      ? { disallowedTools: CURSOR_CODING_TOOLS }
      : {}),
    ...(options.mcpServers !== undefined
      ? { mcpServers: options.mcpServers as Record<string, McpServerConfig> }
      : {}),
    local: {
      cwd: options.cwd,
      customTools: options.customTools
        ? toSdkCustomTools(options.customTools)
        : undefined,
    },
  };
}

function resolveCursorReasoningParameters(
  models: ModelListItem[],
  modelId: string,
  value: string,
): NonNullable<ModelSelection['params']> {
  const reasoning = value.trim();
  if (!reasoning) {
    throw new Error('Cursor conductor reasoning must be a non-empty string.');
  }

  const exactMatches = models.filter((candidate) => candidate.id === modelId);
  const aliasMatches =
    exactMatches.length === 0
      ? models.filter((candidate) => candidate.aliases?.includes(modelId))
      : [];
  const model =
    exactMatches.length === 1
      ? exactMatches[0]
      : exactMatches.length > 1
        ? undefined
        : aliasMatches.length === 1
          ? aliasMatches[0]
          : undefined;
  if (!model) {
    if (exactMatches.length > 1 || aliasMatches.length > 1) {
      throw new Error(
        `Cursor model "${modelId}" matches multiple entries in Cursor.models.list(); ` +
          `cannot validate conductor.reasoning "${reasoning}".`,
      );
    }
    throw new Error(
      `Cursor model "${modelId}" was not returned by Cursor.models.list(); ` +
        `cannot validate conductor.reasoning "${reasoning}".`,
    );
  }

  const reasoningParameters = (model.parameters ?? []).filter((parameter) =>
    isCursorReasoningParameter(parameter.id, parameter.displayName),
  );
  const variantParameters =
    reasoningParameters.length === 0
      ? (model.variants ?? []).flatMap((variant) =>
          variant.params
            .filter((parameter) => isCursorReasoningParameter(parameter.id))
            .map(({ id, value }) => ({ id, value })),
        )
      : [];
  if (reasoningParameters.length === 0 && variantParameters.length === 0) {
    throw new Error(
      `Cursor model "${modelId}" has no identifiable reasoning parameter in Cursor.models.list(); ` +
        `cannot apply conductor.reasoning "${reasoning}".`,
    );
  }

  const normalizedReasoning = reasoning.toLowerCase();
  const matches =
    reasoningParameters.length > 0
      ? reasoningParameters.flatMap((parameter) =>
          parameter.values
            .filter(
              (option) =>
                option.value.trim().toLowerCase() === normalizedReasoning ||
                option.displayName?.trim().toLowerCase() === normalizedReasoning,
            )
            .map((option) => ({ id: parameter.id, value: option.value })),
        )
      : variantParameters
          .filter(
            (parameter) =>
              parameter.value.trim().toLowerCase() === normalizedReasoning,
          )
          .map(({ id, value }) => ({ id, value }));
  const uniqueMatches = [
    ...new Map(matches.map((match) => [`${match.id}\0${match.value}`, match])).values(),
  ];
  if (uniqueMatches.length !== 1) {
    const parameterIds = [
      ...new Set([
        ...reasoningParameters.map(({ id }) => id),
        ...variantParameters.map(({ id }) => id),
      ]),
    ].join(', ');
    const reason =
      uniqueMatches.length === 0
        ? `does not support reasoning value "${reasoning}"`
        : `has ambiguous reasoning parameters for value "${reasoning}"`;
    throw new Error(
      `Cursor model "${modelId}" ${reason} (parameters: ${parameterIds}).`,
    );
  }
  return uniqueMatches;
}

function isCursorReasoningParameter(id: string, displayName?: string): boolean {
  return /reason|think|effort/i.test(`${id} ${displayName ?? ''}`);
}

function toConductorTokenUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): ConductorTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}
