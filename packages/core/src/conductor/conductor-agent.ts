import {
  Agent,
  AuthenticationError,
  CursorAgentError,
  type AgentOptions,
  type AgentUsage,
  type GetUsageOptions,
  type McpServerConfig,
  type RunResult,
  type SDKAgent,
  type SDKCustomTool,
  type TokenUsage,
} from '@cursor/sdk';
import { ensureCursorSdkRipgrepPath } from './configure-cursor-sdk-env.js';
import { CONDUCTOR_AUTH_HINT, resolveConductorApiKey } from './conductor-auth.js';
import { formatConductorToolName } from './conductor-tool-name.js';
import { resolveConductorModelId } from './resolve-conductor-model-id.js';

export interface ConductorAgentOptions {
  cwd: string;
  apiKey?: string;
  modelId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  customTools?: Record<string, SDKCustomTool>;
  onStreamText?: (text: string) => void;
}

export interface ConductorSendResult {
  runId: string;
  status: RunResult['status'];
  result?: string;
  error?: RunResult['error'];
  usage?: TokenUsage;
  modelId?: string;
}

export interface ConductorToolCallStartedInfo {
  runId: string;
  tool: string;
  callId: string;
}

export interface ConductorSendCallbacks {
  onToolCallStarted?: (info: ConductorToolCallStartedInfo) => void;
}

export class ConductorAgent {
  private constructor(private readonly agent: SDKAgent) {}

  get agentId(): string {
    return this.agent.agentId;
  }

  static async create(options: ConductorAgentOptions): Promise<ConductorAgent> {
    ensureCursorSdkEnv();
    const agent = await Agent.create(buildAgentOptions(options));
    return new ConductorAgent(agent);
  }

  static async resume(
    agentId: string,
    options: ConductorAgentOptions,
  ): Promise<ConductorAgent> {
    ensureCursorSdkEnv();
    const agent = await Agent.resume(agentId, buildAgentOptions(options));
    return new ConductorAgent(agent);
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
        error: result.error,
        usage: result.usage ?? run.usage,
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

  async getUsage(options?: GetUsageOptions): Promise<AgentUsage> {
    return this.agent.getUsage(options);
  }

  async close(): Promise<void> {
    await this.agent[Symbol.asyncDispose]();
  }
}

let cursorSdkEnvReady = false;

function ensureCursorSdkEnv(): void {
  if (cursorSdkEnvReady) {
    return;
  }
  cursorSdkEnvReady = true;
  ensureCursorSdkRipgrepPath();
}

function buildAgentOptions(options: ConductorAgentOptions): AgentOptions {
  const apiKey = resolveConductorApiKey(options.apiKey);

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    model: { id: resolveConductorModelId(options.modelId) },
    mode: 'agent',
    ...(options.mcpServers !== undefined
      ? { mcpServers: options.mcpServers }
      : {}),
    local: {
      cwd: options.cwd,
      customTools: options.customTools,
    },
  };
}
