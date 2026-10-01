import { randomUUID } from 'node:crypto';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  getEnvApiKey,
  getModel,
  getModels,
  getProviders,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai/compat';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
  ConductorAgentUsage,
  ConductorSendCallbacks,
  ConductorSendResult,
  ConductorTokenUsage,
} from './conductor-agent.js';
import { toPiAgentTools } from './conductor-tool-pi-adapter.js';
import { PiConductorSession } from './pi-conductor-session.js';
import {
  loadPiResources,
  type PiAuthFile,
  type PiResourceLoaderOptions,
  type PiResources,
  type PiSettingsFile,
} from './pi-resource-loader.js';
import {
  createPiMcpBridge,
  type PiMcpBridge,
} from './pi-mcp-bridge.js';

interface PiSendState {
  runId: string;
  callbacks?: ConductorSendCallbacks;
  finalMessage?: AssistantMessage;
}

export interface PiResolvedModel {
  provider: string;
  modelId: string;
  model: Model<any>;
  apiKey?: string;
}

/** Resolve the Pi model/auth selection from the standard resource roots. */
export async function resolvePiModelConfig(
  options: PiResourceLoaderOptions & {
    modelId?: string;
    apiKey?: string;
  },
): Promise<PiResolvedModel> {
  const resources = await loadPiResources(options);
  return resolvePiModelConfigFromResources(options, resources);
}

function resolvePiModelConfigFromResources(
  options: PiResourceLoaderOptions & {
    modelId?: string;
    apiKey?: string;
  },
  resources: PiResources,
): PiResolvedModel {
  const env = options.env ?? process.env;
  const settings = resources.settings;
  const auth = resources.auth;
  const selection = resolvePiModelSelection(options.modelId, settings);
  const model = getModel(
    selection.provider as never,
    selection.modelId as never,
  ) as Model<any> | undefined;

  if (!model) {
    throw new Error(
      `Pi conductor model "${selection.provider}/${selection.modelId}" was not found in pi-ai. ` +
        'Set defaultProvider/defaultModel in Pi settings.json or pass a built-in provider/model id.',
    );
  }

  const apiKey =
    options.apiKey ??
    resolvePiAuthKey(auth, selection.provider, env) ??
    resolvePiSettingsApiKey(settings, selection.provider, env) ??
    getEnvApiKey(selection.provider, toProviderEnv(env));

  return {
    provider: selection.provider,
    modelId: selection.modelId,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

/** Pi implementation of the backend-neutral conductor interface. */
export class PiConductorAgent implements ConductorAgent {
  private readonly unsubscribe: () => void;
  private activeSend?: PiSendState;
  private closed = false;
  private closePromise?: Promise<void>;
  private hasUsage = false;
  private rawCostCents = 0;
  private chargedCents = 0;

  private constructor(
    private readonly agent: Agent,
    private readonly session: PiConductorSession,
    private readonly mcpBridge: PiMcpBridge | undefined,
    public readonly agentId: string,
    private readonly modelId: string,
    private readonly onStreamText?: (text: string) => void,
  ) {
    this.unsubscribe = this.agent.subscribe((event) => this.handleEvent(event));
  }

  static async create(
    options: ConductorAgentCreateOptions,
  ): Promise<PiConductorAgent> {
    const agentId = randomUUID();
    const resources = await loadPiResources(options);
    const resolved = resolvePiModelConfigFromResources(options, resources);
    const session = await PiConductorSession.create(options.cwd, agentId);
    const mcpBridge = await createPiMcpBridge(options.mcpServers, {
      cwd: options.cwd,
    });
    try {
      return new PiConductorAgent(
        createPiAgent(
          agentId,
          options,
          resolved,
          session.messages,
          mcpBridge,
          resources,
        ),
        session,
        mcpBridge,
        agentId,
        resolved.modelId,
        options.onStreamText,
      );
    } catch (error) {
      await mcpBridge?.close();
      throw error;
    }
  }

  static async resume(
    agentId: string,
    options: ConductorAgentCreateOptions,
  ): Promise<PiConductorAgent> {
    const resources = await loadPiResources(options);
    const resolved = resolvePiModelConfigFromResources(options, resources);
    const session = await PiConductorSession.resume(options.cwd, agentId);
    const mcpBridge = await createPiMcpBridge(options.mcpServers, {
      cwd: options.cwd,
    });
    try {
      return new PiConductorAgent(
        createPiAgent(
          agentId,
          options,
          resolved,
          session.messages,
          mcpBridge,
          resources,
        ),
        session,
        mcpBridge,
        agentId,
        resolved.modelId,
        options.onStreamText,
      );
    } catch (error) {
      await mcpBridge?.close();
      throw error;
    }
  }

  async send(
    prompt: string,
    callbacks?: ConductorSendCallbacks,
  ): Promise<ConductorSendResult> {
    const runId = randomUUID();
    if (this.closed) {
      return {
        runId,
        status: 'error',
        error: { message: 'Pi conductor agent is closed.' },
      };
    }
    if (this.activeSend) {
      return {
        runId,
        status: 'error',
        error: { message: 'Pi conductor agent already has a send in progress.' },
      };
    }

    const state: PiSendState = { runId, callbacks };
    this.activeSend = state;
    try {
      await this.agent.prompt(prompt);
    } catch (error) {
      return {
        runId,
        status: 'error',
        error: { message: errorMessage(error) },
        modelId: this.modelId,
      };
    } finally {
      this.activeSend = undefined;
    }

    const finalMessage =
      state.finalMessage ?? lastAssistantMessage(this.agent.state.messages);
    if (!finalMessage) {
      return {
        runId,
        status: 'finished',
        modelId: this.modelId,
      };
    }

    this.recordUsage(finalMessage);
    const status = statusFromStopReason(finalMessage.stopReason);
    return {
      runId,
      status,
      result: assistantText(finalMessage) || undefined,
      ...(finalMessage.errorMessage
        ? { error: { message: finalMessage.errorMessage } }
        : {}),
      usage: toConductorTokenUsage(finalMessage.usage),
      modelId: finalMessage.model || this.modelId,
    };
  }

  /** Pi's core agent has no reload operation; settings are loaded at create. */
  async reload(): Promise<void> {}

  async getUsage(): Promise<ConductorAgentUsage> {
    return this.hasUsage
      ? {
          cost: {
            rawCostCents: this.rawCostCents,
            chargedCents: this.chargedCents,
          },
        }
      : {};
  }

  /** Resume recompiles and reinstalls the native system prompt on each run. */
  async setSystemPrompt(systemPrompt: string): Promise<void> {
    this.agent.state.systemPrompt = systemPrompt;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      try {
        this.agent.abort();
        await this.agent.waitForIdle();
        await this.session.appendNewMessages(this.agent.state.messages);
      } finally {
        try {
          this.unsubscribe();
        } finally {
          await this.mcpBridge?.close();
        }
      }
    })();
    return this.closePromise;
  }

  private async handleEvent(event: AgentEvent): Promise<void> {
    const activeSend = this.activeSend;
    if (event.type === 'tool_execution_start') {
      activeSend?.callbacks?.onToolCallStarted?.({
        runId: activeSend.runId,
        tool: event.toolName,
        callId: event.toolCallId,
      });
      return;
    }

    if (event.type === 'message_update') {
      if (event.assistantMessageEvent.type === 'text_delta') {
        this.onStreamText?.(event.assistantMessageEvent.delta);
      }
      return;
    }

    if (event.type === 'agent_end' && activeSend) {
      activeSend.finalMessage = lastAssistantMessage(event.messages);
    }

    if (event.type === 'agent_end') {
      // Pi's failure/abort event can contain only the failure assistant while
      // agent.state.messages already contains the user prompt and failure.
      // Persist the full in-memory suffix so every run is written once in
      // transcript order; close() uses the same serialized operation.
      await this.session.appendNewMessages(this.agent.state.messages);
    }
  }

  private recordUsage(message: AssistantMessage): void {
    this.hasUsage = true;
    this.rawCostCents += message.usage.cost.total * 100;
    this.chargedCents += message.usage.cost.total * 100;
  }
}

/** Create the Pi conductor backend factory. */
export function createPiConductorAgentFactory(): ConductorAgentFactory {
  return {
    create: (options) => PiConductorAgent.create(options),
    resume: (agentId, options) => PiConductorAgent.resume(agentId, options),
  };
}

function createPiAgent(
  agentId: string,
  options: ConductorAgentCreateOptions,
  resolved: PiResolvedModel,
  messages: readonly AgentMessage[],
  mcpBridge: PiMcpBridge | undefined,
  resources: PiResources,
): Agent {
  const tools = uniquePiTools(
    options.customTools ? toPiAgentTools(options.customTools) : [],
    mcpBridge?.tools ?? [],
    resources.extensionTools,
  );

  return new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: resolved.model,
      // Do not add Pi's built-in coding tools. Harness tools are the complete
      // loadout; repository work is delegated to worker ACP sessions.
      tools,
      messages: [...messages],
    },
    sessionId: agentId,
    getApiKey: (provider) =>
      provider === resolved.provider
        ? (resolved.apiKey ?? getEnvApiKey(provider))
        : getEnvApiKey(provider),
  });
}

function uniquePiTools(...groups: AgentTool[][]): AgentTool[] {
  const tools = new Map<string, AgentTool>();
  for (const group of groups) {
    for (const tool of group) {
      if (!tools.has(tool.name)) {
        tools.set(tool.name, tool);
      }
    }
  }
  return [...tools.values()];
}

function resolvePiModelSelection(
  requestedModelId: string | undefined,
  settings: PiSettingsFile,
): { provider: string; modelId: string } {
  const requested = normalizeConfiguredString(requestedModelId);
  const configured = firstString(settings.defaultModel, settings.model, settings.modelId);
  const selected = requested ?? configured;
  let provider = normalizeConfiguredString(settings.defaultProvider);
  let modelId = selected;

  if (selected?.includes('/')) {
    const slash = selected.indexOf('/');
    provider = selected.slice(0, slash);
    modelId = selected.slice(slash + 1);
  }

  if (!modelId) {
    throw new Error(
      'Pi conductor model is not configured. Set defaultProvider/defaultModel in Pi settings.json or pass modelId as provider/model.',
    );
  }

  if (!provider) {
    const matches = getProviders().flatMap((candidate) =>
      getModels(candidate).some((model) => model.id === modelId)
        ? [candidate]
        : [],
    );
    if (matches.length === 1) provider = matches[0];
  }

  if (!provider) {
    throw new Error(
      `Pi conductor provider is not configured for model "${modelId}". Set defaultProvider in Pi settings.json or use provider/model.`,
    );
  }

  return { provider, modelId };
}

function resolvePiAuthKey(
  auth: PiAuthFile,
  provider: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const entry = auth[provider];
  if (typeof entry === 'string') return expandEnvReference(entry, env);
  if (!isRecord(entry)) return undefined;

  for (const key of ['key', 'apiKey', 'token', 'accessToken', 'access']) {
    const value = entry[key];
    if (typeof value === 'string') {
      return expandEnvReference(value, env);
    }
  }
  return undefined;
}

function resolvePiSettingsApiKey(
  settings: PiSettingsFile,
  provider: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (typeof settings.apiKey === 'string') {
    return expandEnvReference(settings.apiKey, env);
  }
  if (!isRecord(settings.apiKeys)) return undefined;
  const value = settings.apiKeys[provider];
  return typeof value === 'string' ? expandEnvReference(value, env) : undefined;
}

function expandEnvReference(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (value.startsWith('!')) {
    // Pi supports command-backed credentials. Do not execute arbitrary commands
    // from a harness config; #356/#358 can define a deliberate credential hook.
    return undefined;
  }
  const variable = /^\$\{([^}]+)\}$/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return variable ? env[variable[1]] : value;
}

function normalizeConfiguredString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized === 'default' || normalized === 'auto') {
    return undefined;
  }
  return normalized;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeConfiguredString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function lastAssistantMessage(
  messages: readonly AgentMessage[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

function statusFromStopReason(
  stopReason: AssistantMessage['stopReason'],
): ConductorSendResult['status'] {
  if (stopReason === 'error') return 'error';
  if (stopReason === 'aborted') return 'cancelled';
  return 'finished';
}

function toConductorTokenUsage(usage: AssistantMessage['usage']): ConductorTokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toProviderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
