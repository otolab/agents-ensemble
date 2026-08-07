import {
  Agent,
  AuthenticationError,
  CursorAgentError,
  type AgentOptions,
  type RunResult,
  type SDKAgent,
  type SDKCustomTool,
} from '@cursor/sdk';
import {
  CONDUCTOR_AUTH_HINT,
  resolveConductorApiKey,
} from './conductor-auth.js';

export interface ConductorAgentOptions {
  cwd: string;
  apiKey?: string;
  modelId?: string;
  customTools?: Record<string, SDKCustomTool>;
  onStreamText?: (text: string) => void;
}

export interface ConductorSendResult {
  runId: string;
  status: RunResult['status'];
  result?: string;
}

export class ConductorAgent {
  private constructor(private readonly agent: SDKAgent) {}

  get agentId(): string {
    return this.agent.agentId;
  }

  static async create(options: ConductorAgentOptions): Promise<ConductorAgent> {
    const agent = await Agent.create(buildAgentOptions(options));
    return new ConductorAgent(agent);
  }

  static async resume(
    agentId: string,
    options: ConductorAgentOptions,
  ): Promise<ConductorAgent> {
    const agent = await Agent.resume(agentId, buildAgentOptions(options));
    return new ConductorAgent(agent);
  }

  async send(prompt: string): Promise<ConductorSendResult> {
    try {
      const run = await this.agent.send(prompt, {
        onDelta: ({ update }) => {
          if (update.type === 'text-delta') {
            // streaming handled by caller if needed
          }
        },
      });
      const result = await run.wait();
      return {
        runId: run.id,
        status: result.status,
        result: typeof result.result === 'string' ? result.result : undefined,
      };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw new Error(`${error.message}\n\n${CONDUCTOR_AUTH_HINT}`);
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

  async close(): Promise<void> {
    await this.agent[Symbol.asyncDispose]();
  }
}

function buildAgentOptions(options: ConductorAgentOptions): AgentOptions {
  const apiKey = resolveConductorApiKey(options.apiKey);

  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    model: { id: options.modelId ?? 'composer-2.5' },
    mode: 'plan',
    local: {
      cwd: options.cwd,
      settingSources: ['project'],
      customTools: options.customTools,
    },
  };
}
