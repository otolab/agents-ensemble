import {
  Agent,
  AuthenticationError,
  CursorAgentError,
  type AgentOptions,
  type McpServerConfig,
  type SDKAgent,
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

/** Cursor SDK implementation of the backend-neutral conductor interface. */
export class CursorSdkConductorAgent implements ConductorAgent {
  private constructor(private readonly agent: SDKAgent) {}

  get agentId(): string {
    return this.agent.agentId;
  }

  static async create(
    options: ConductorAgentCreateOptions,
  ): Promise<CursorSdkConductorAgent> {
    ensureCursorSdkEnv();
    const agent = await Agent.create(buildAgentOptions(options));
    return new CursorSdkConductorAgent(agent);
  }

  static async resume(
    agentId: string,
    options: ConductorAgentCreateOptions,
  ): Promise<CursorSdkConductorAgent> {
    ensureCursorSdkEnv();
    const agent = await Agent.resume(agentId, buildAgentOptions(options));
    return new CursorSdkConductorAgent(agent);
  }

  async send(
    prompt: string,
    callbacks?: ConductorSendCallbacks,
  ): Promise<ConductorSendResult> {
    try {
      const pendingRunId = { value: '' };
      const run = await this.agent.send(prompt, {
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
      pendingRunId.value = run.id;
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

function buildAgentOptions(options: ConductorAgentCreateOptions): AgentOptions {
  const apiKey = resolveConductorApiKey(options.apiKey);

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    model: { id: resolveConductorModelId(options.modelId) },
    mode: 'agent',
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
