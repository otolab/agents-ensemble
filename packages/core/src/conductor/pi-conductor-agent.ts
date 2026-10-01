import { randomUUID } from 'node:crypto';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  getModel,
  getModels,
  getProviders,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai/compat';
import {
  createPiConductorAuthContext,
  resolvePiConductorApiKey,
} from './conductor-pi-auth.js';
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
  expandPiResourcePrompt,
  formatPiSkillsForPrompt,
  loadPiResources,
  type PiModelDefinition,
  type PiModelCost,
  type PiModelOverride,
  type PiModelsFile,
  type PiProviderConfig,
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
  usesModelRegistry?: boolean;
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
  const authContext = createPiConductorAuthContext(options);
  return resolvePiModelConfigFromResources(options, resources, authContext);
}

async function resolvePiModelConfigFromResources(
  options: PiResourceLoaderOptions & {
    modelId?: string;
    apiKey?: string;
  },
  resources: PiResources,
  authContext: ReturnType<typeof createPiConductorAuthContext>,
): Promise<PiResolvedModel> {
  const env = options.env ?? process.env;
  const settings = resources.settings;
  const selection = resolvePiModelSelection(options.modelId, settings, resources.models);
  const providerConfig = resources.models.providers[selection.provider];
  const projectProviderConfig = resources.modelsLayers.at(-1)?.providers[selection.provider];
  const projectDefinesModel = projectProviderConfig?.models?.some(
    (candidate) => candidate.id === selection.modelId,
  );
  const registryModel = projectDefinesModel
    ? undefined
    : authContext.modelRegistry.find(selection.provider, selection.modelId);
  const apiKey = await resolvePiConductorApiKey({
    authStorage: authContext.authStorage,
    resources,
    provider: selection.provider,
    explicitApiKey: options.apiKey,
    env,
  });

  const builtInModel = getModel(
    selection.provider as never,
    selection.modelId as never,
  ) as Model<any> | undefined;
  const model = resolvePiModel(
    selection.provider,
    selection.modelId,
    providerConfig,
    registryModel ?? builtInModel,
    registryModel,
  );

  if (!model) {
    throw new Error(
      `Pi conductor model "${selection.provider}/${selection.modelId}" was not found in pi-ai or models.json. ` +
        'Set defaultProvider/defaultModel in Pi settings.json or pass a built-in provider/model id.',
    );
  }

  return {
    provider: selection.provider,
    modelId: selection.modelId,
    model: applyPiProviderRequestConfig(model, providerConfig, apiKey),
    ...(registryModel ? { usesModelRegistry: true } : {}),
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
    private readonly resources: PiResources,
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
    const authContext = createPiConductorAuthContext(options);
    const resolved = await resolvePiModelConfigFromResources(options, resources, authContext);
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
          authContext.authStorage,
          authContext.modelRegistry,
        ),
        session,
        mcpBridge,
        resources,
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
    const authContext = createPiConductorAuthContext(options);
    const resolved = await resolvePiModelConfigFromResources(options, resources, authContext);
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
          authContext.authStorage,
          authContext.modelRegistry,
        ),
        session,
        mcpBridge,
        resources,
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
      await this.agent.prompt(expandPiResourcePrompt(prompt, this.resources));
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
    this.agent.state.systemPrompt = withPiSkills(systemPrompt, this.resources);
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
  authStorage: ReturnType<typeof createPiConductorAuthContext>['authStorage'],
  modelRegistry: ReturnType<typeof createPiConductorAuthContext>['modelRegistry'],
): Agent {
  const tools = uniquePiTools(
    options.customTools ? toPiAgentTools(options.customTools) : [],
    mcpBridge?.tools ?? [],
    resources.extensionTools,
  );

  return new Agent({
    initialState: {
      systemPrompt: withPiSkills(options.systemPrompt, resources),
      model: resolved.model,
      // Do not add Pi's built-in coding tools. Harness tools are the complete
      // loadout; repository work is delegated to worker ACP sessions.
      tools,
      messages: [...messages],
    },
    sessionId: agentId,
    getApiKey: async (provider) => {
      const apiKey = await resolvePiConductorApiKey({
        authStorage,
        resources,
        provider,
        explicitApiKey:
          provider === resolved.provider ? options.apiKey : undefined,
      });
      if (!resolved.usesModelRegistry || provider !== resolved.provider) {
        return apiKey;
      }

      let registryModel = modelRegistry.find(provider, resolved.modelId);
      if (!registryModel) return apiKey;

      const requestAuth = await modelRegistry.getApiKeyAndHeaders(registryModel);
      const projectProviderConfig = resources.modelsLayers.at(-1)?.providers[provider];
      const headers = mergePiHeaders(
        resolved.model.headers,
        registryModel.headers,
        requestAuth.ok ? requestAuth.headers : undefined,
        projectProviderConfig?.headers,
      );
      const requestModel = {
        ...resolved.model,
        ...(projectProviderConfig?.baseUrl
          ? { baseUrl: projectProviderConfig.baseUrl }
          : registryModel.baseUrl
            ? { baseUrl: registryModel.baseUrl }
            : {}),
        ...(registryModel.api ? { api: registryModel.api } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      Object.assign(resolved.model, requestModel);

      const registryApiKey = requestAuth.ok ? requestAuth.apiKey : undefined;
      return apiKey ?? registryApiKey;
    },
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

function withPiSkills(systemPrompt: string, resources: PiResources): string {
  return `${systemPrompt}${formatPiSkillsForPrompt(resources.skills)}`;
}

function resolvePiModel(
  provider: string,
  modelId: string,
  providerConfig: PiProviderConfig | undefined,
  builtInModel: Model<any> | undefined,
  registryModel?: Model<any>,
): Model<any> | undefined {
  const definition = providerConfig?.models?.find((candidate) => candidate.id === modelId);
  let model = registryModel ?? (definition && providerConfig
    ? createPiModel(provider, providerConfig, definition)
    : builtInModel);
  if (!model) return undefined;

  const override = providerConfig?.modelOverrides?.[modelId];
  if (providerConfig?.baseUrl || providerConfig?.compat) {
    model = {
      ...model,
      ...(providerConfig.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
      ...(providerConfig.compat
        ? { compat: mergePiObjects(model.compat, providerConfig.compat) as Model<any>['compat'] }
        : {}),
    };
  }
  return override ? applyPiModelOverride(model, override) : model;
}

function createPiModel(
  provider: string,
  providerConfig: PiProviderConfig,
  definition: PiModelDefinition,
): Model<any> {
  const api = definition.api ?? providerConfig.api;
  const baseUrl = definition.baseUrl ?? providerConfig.baseUrl;
  if (!api || !baseUrl) {
    throw new Error(
      `Pi models.json provider "${provider}" model "${definition.id}" requires api and baseUrl.`,
    );
  }
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api,
    provider,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    thinkingLevelMap: definition.thinkingLevelMap,
    input: definition.input ?? ['text'],
    cost: normalizePiModelCost(definition.cost),
    contextWindow: definition.contextWindow ?? 128000,
    maxTokens: definition.maxTokens ?? 16384,
    headers: mergePiHeaders(providerConfig.headers, definition.headers),
    compat: mergePiObjects(providerConfig.compat, definition.compat) as Model<any>['compat'],
  };
}

function applyPiModelOverride(model: Model<any>, override: PiModelOverride): Model<any> {
  return {
    ...model,
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
    ...(override.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: { ...model.thinkingLevelMap, ...override.thinkingLevelMap } }
      : {}),
    ...(override.input !== undefined ? { input: override.input } : {}),
    ...(override.cost !== undefined
      ? { cost: normalizePiModelCost({ ...model.cost, ...override.cost }) }
      : {}),
    ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
    ...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
    ...(override.headers !== undefined
      ? { headers: mergePiHeaders(model.headers, override.headers) }
      : {}),
    ...(override.compat !== undefined
      ? { compat: mergePiObjects(model.compat, override.compat) as Model<any>['compat'] }
      : {}),
  };
}

function applyPiProviderRequestConfig(
  model: Model<any>,
  providerConfig: PiProviderConfig | undefined,
  apiKey: string | undefined,
): Model<any> {
  if (!providerConfig) return model;
  const headers = mergePiHeaders(model.headers, providerConfig.headers);
  if (providerConfig.authHeader && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return Object.keys(headers).length > 0 ? { ...model, headers } : model;
}

function normalizePiModelCost(cost: Partial<PiModelCost> | undefined) {
  const defaults = emptyPiModelCost();
  return {
    input: numberValue(cost?.input, defaults.input),
    output: numberValue(cost?.output, defaults.output),
    cacheRead: numberValue(cost?.cacheRead, defaults.cacheRead),
    cacheWrite: numberValue(cost?.cacheWrite, defaults.cacheWrite),
    ...(cost?.tiers ? { tiers: cost.tiers } : {}),
  };
}

function emptyPiModelCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mergePiHeaders(
  ...headers: Array<Record<string, string> | undefined>
): Record<string, string> {
  return Object.assign({}, ...headers.filter((value): value is Record<string, string> => Boolean(value)));
}

function mergePiObjects(
  ...values: unknown[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    if (isRecord(value)) Object.assign(merged, value);
  }
  return merged;
}

function resolvePiModelSelection(
  requestedModelId: string | undefined,
  settings: PiSettingsFile,
  models: PiModelsFile,
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
    const candidates = new Set([...getProviders(), ...Object.keys(models.providers)]);
    const matches = [...candidates].flatMap((candidate) => {
      const builtInModels = getModels(candidate as never) ?? [];
      const customModels = models.providers[candidate]?.models ?? [];
      return builtInModels.some((model) => model.id === modelId) ||
        customModels.some((model) => model.id === modelId)
        ? [candidate]
        : [];
    });
    if (matches.length === 1) provider = matches[0];
  }

  if (!provider) {
    throw new Error(
      `Pi conductor provider is not configured for model "${modelId}". Set defaultProvider in Pi settings.json or use provider/model.`,
    );
  }

  return { provider, modelId };
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
