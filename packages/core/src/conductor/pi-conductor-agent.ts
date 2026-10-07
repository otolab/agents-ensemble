import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  getModel,
  getModels,
  getProviders,
} from '@earendil-works/pi-ai/compat';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  type ExtensionUIContext,
  type LoadedMcpConfig,
  type McpServerConfig as PiMcpServerConfig,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
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
import { toPiCodingAgentTools } from './conductor-tool-pi-adapter.js';
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
import type { McpServerConfigMap } from '../mcp/load-mcp-config.js';

/** Project-local Pi transcript storage used by the conductor backend. */
export const PI_SESSION_ROOT = '.ensemble/pi/sessions';

interface PiSendState {
  runId: string;
  callbacks?: ConductorSendCallbacks;
  finalMessage?: AssistantMessage;
}

interface PiMcpStartupState {
  error?: string;
}

const PI_MCP_STARTUP_OBSERVATION_MS = 2_000;

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
  const authContext = await createPiConductorAuthContext(options, resources);
  return resolvePiModelConfigFromResources(options, resources, authContext);
}

async function resolvePiModelConfigFromResources(
  options: PiResourceLoaderOptions & {
    modelId?: string;
    apiKey?: string;
  },
  resources: PiResources,
  authContext: Awaited<ReturnType<typeof createPiConductorAuthContext>>,
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
    modelRuntime: authContext.modelRuntime,
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

  constructor(
    private readonly session: AgentSession,
    private readonly resources: PiResources,
    private readonly systemPromptRef: { value: string },
    public readonly agentId: string,
    private readonly modelId: string,
    private readonly mcpStartupState: PiMcpStartupState,
    private readonly onStreamText?: (text: string) => void,
  ) {
    this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
  }

  static async create(
    options: ConductorAgentCreateOptions,
  ): Promise<PiConductorAgent> {
    return createPiConductorSession(randomUUID(), options, 'startup');
  }

  static async resume(
    agentId: string,
    options: ConductorAgentCreateOptions,
  ): Promise<PiConductorAgent> {
    return createPiConductorSession(agentId, options, 'resume');
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
    if (this.mcpStartupState.error) {
      return {
        runId,
        status: 'error',
        error: {
          message: this.mcpStartupState.error,
          code: 'MCP_CONNECTION_FAILED',
        },
        modelId: this.modelId,
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
      await this.session.prompt(expandPiResourcePrompt(prompt, this.resources), {
        expandPromptTemplates: false,
        source: 'rpc',
      });
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
      state.finalMessage ?? lastAssistantMessage(this.session.state.messages);
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

  async reload(): Promise<void> {
    await this.session.reload();
  }

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
    this.systemPromptRef.value = withPiSkills(systemPrompt, this.resources);
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      try {
        await this.session.abort();
      } finally {
        try {
          this.unsubscribe();
        } finally {
          this.session.dispose();
        }
      }
    })();
    return this.closePromise;
  }

  private handleEvent(event: AgentSessionEvent): void {
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

type PiSessionStartReason = 'startup' | 'resume';

async function createPiConductorSession(
  agentId: string,
  options: ConductorAgentCreateOptions,
  reason: PiSessionStartReason,
): Promise<PiConductorAgent> {
  const piMcpResolution = { cwd: options.cwd };
  // Validate the harness-resolved map before creating the SDK session so an
  // unsupported transport fails with an actionable Pi-specific error.
  if (options.mcpServers) loadPiMcpConfig(options.mcpServers, piMcpResolution);
  const resources = await loadPiResources(options);
  const authContext = await createPiConductorAuthContext(options, resources);
  const resolved = await resolvePiModelConfigFromResources(options, resources, authContext);
  if (options.apiKey !== undefined) {
    await authContext.modelRuntime.setRuntimeApiKey(resolved.provider, options.apiKey);
  }

  const sessionDir = join(options.cwd, PI_SESSION_ROOT);
  let sessionManager: SessionManager;
  let previousSessionFile: string | undefined;
  if (reason === 'resume') {
    previousSessionFile = SessionManager.findById(options.cwd, agentId, sessionDir);
    if (!previousSessionFile) {
      throw new Error(
        `Pi session not found for resume (sessionId=${agentId}, cwd=${options.cwd}, ` +
          `sessionsRoot=${PI_SESSION_ROOT})`,
      );
    }
    sessionManager = SessionManager.open(
      previousSessionFile,
      sessionDir,
      options.cwd,
    );
  } else {
    sessionManager = SessionManager.create(options.cwd, sessionDir, { id: agentId });
  }

  const systemPromptRef = {
    value: withPiSkills(options.systemPrompt, resources),
  };
  const settingsManager = SettingsManager.create(options.cwd, authContext.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: authContext.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: systemPromptRef.value,
    extensionFactories: [
      createMcpExtension({
        loadConfig: () => loadPiMcpConfig(options.mcpServers, piMcpResolution),
      }),
      createCodemodeExtension({ mode: 'on' }),
      createToolSearchExtension(),
      createPiSystemPromptExtension(systemPromptRef),
    ],
  });
  await resourceLoader.reload();
  // The ensemble resource roots use `.ensemble/pi/settings.json`, while the
  // Pi SDK's SettingsManager only discovers `<cwd>/.pi/settings.json` as its
  // project layer. Apply the settings that the headless conductor supports
  // from the already merged ensemble resources without handing sessionDir (or
  // any other unsupported setting) back to the SDK.
  applyPiHeadlessSettings(settingsManager, resources.settings);

  let session: AgentSession | undefined;
  try {
    const mcpStartupState: PiMcpStartupState = {};
    const result = await createAgentSession({
      cwd: options.cwd,
      agentDir: authContext.agentDir,
      modelRuntime: authContext.modelRuntime,
      model: resolved.model,
      sessionManager,
      settingsManager,
      resourceLoader,
      // Profile-controlled: when disabled, keep repository operations in
      // worker ACP sessions and expose only harness/MCP/extension tools.
      ...(options.builtinTools === false ? { noTools: 'builtin' as const } : {}),
      customTools: uniquePiTools(
        options.customTools ? toPiCodingAgentTools(options.customTools) : [],
        resources.extensionTools.map(toPiCodingAgentTool),
      ),
      sessionStartEvent: {
        type: 'session_start',
        reason,
        ...(previousSessionFile ? { previousSessionFile } : {}),
      },
    });
    session = result.session;
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: createPiHeadlessExtensionUi(mcpStartupState),
      onError: (error) => {
        if (error.extensionPath.includes('mcp')) {
          mcpStartupState.error =
            `Pi MCP extension failed during ${error.event}: ${error.error}`;
        }
      },
    });
    await observePiMcpStartup(session, options.mcpServers, mcpStartupState);
    if (mcpStartupState.error) {
      throw new Error(mcpStartupState.error);
    }
    return new PiConductorAgent(
      session,
      resources,
      systemPromptRef,
      agentId,
      resolved.modelId,
      mcpStartupState,
      options.onStreamText,
    );
  } catch (error) {
    session?.dispose();
    throw error;
  }
}

function applyPiHeadlessSettings(
  settingsManager: SettingsManager,
  settings: PiSettingsFile,
): void {
  type SettingsOverrides = Parameters<SettingsManager['applyOverrides']>[0];
  const overrides: SettingsOverrides = {};
  if (settings.compaction !== undefined) {
    overrides.compaction = settings.compaction as SettingsOverrides['compaction'];
  }
  if (settings.branchSummary !== undefined) {
    overrides.branchSummary = settings.branchSummary as SettingsOverrides['branchSummary'];
  }
  settingsManager.applyOverrides(overrides);
}

function createPiHeadlessExtensionUi(
  state: PiMcpStartupState,
): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string, type?: 'info' | 'warning' | 'error') => {
      if (
        message.startsWith('MCP failed to load:') ||
        (type === 'warning' && message.startsWith('MCP servers need attention:'))
      ) {
        state.error = `Pi MCP startup failed: ${message}`;
      }
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    custom: async () => undefined,
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    get theme() {
      return undefined;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Headless conductor has no theme.' }),
  } as unknown as ExtensionUIContext;
}

async function observePiMcpStartup(
  session: AgentSession,
  servers: McpServerConfigMap | undefined,
  state: PiMcpStartupState,
): Promise<void> {
  const names = Object.keys(servers ?? {});
  if (names.length === 0 || typeof session.getAllTools !== 'function') return;

  const deadline = Date.now() + PI_MCP_STARTUP_OBSERVATION_MS;
  while (Date.now() < deadline && !state.error) {
    const tools = session.getAllTools();
    if (
      names.every((name) => {
        const namespace = name.replace(/[^A-Za-z0-9_]/g, '_');
        return tools.some((tool) => tool.name.startsWith(`mcp__${namespace}__`));
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function toPiCodingAgentTool(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(
        toolCallId,
        params as never,
        signal,
        onUpdate as never,
      ),
  };
}

function uniquePiTools(...groups: ToolDefinition[][]): ToolDefinition[] {
  const tools = new Map<string, ToolDefinition>();
  for (const group of groups) {
    for (const tool of group) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

function createPiSystemPromptExtension(
  systemPromptRef: { value: string },
): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      // Change only Pi's custom preamble. MCP/codemode sections assembled by
      // the official extensions remain intact on every request and resume.
      event.systemPromptOptions.customPrompt = systemPromptRef.value;
    });
  };
}

export function loadPiMcpConfig(
  servers: McpServerConfigMap | undefined,
  options: PiMcpConfigResolutionOptions = {},
): LoadedMcpConfig {
  const resolution = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  };
  return {
    servers: Object.entries(servers ?? {}).map(([name, config]) => ({
      name,
      config: toPiMcpServerConfig(name, config, resolution),
      source: '<agents-ensemble-resolved-mcp.json>',
      scope: 'project' as const,
    })),
    autoEnableCodemode: true,
    errors: [],
  };
}

export interface PiMcpConfigResolutionOptions {
  /** Workspace used for Cursor's `${workspaceFolder}` placeholders. */
  cwd?: string;
  /** Environment used for Cursor's `${env:NAME}` placeholders. */
  env?: NodeJS.ProcessEnv;
}

function toPiMcpServerConfig(
  name: string,
  config: McpServerConfigMap[string],
  resolution: Required<PiMcpConfigResolutionOptions>,
): PiMcpServerConfig {
  if (config.type === 'sse') {
    throw new Error(
      `MCP server "${name}" uses SSE, which Pi 1.0 does not support. ` +
        'Use stdio or streamable HTTP instead.',
    );
  }
  if (config.command) {
    return {
      type: 'stdio',
      command: expandPiMcpString(config.command, name, 'command', resolution),
      ...(config.args
        ? {
            args: config.args.map((value, index) =>
              expandPiMcpString(value, name, `args[${index}]`, resolution),
            ),
          }
        : {}),
      ...(config.env
        ? { env: expandPiMcpRecord(config.env, name, 'env', resolution) }
        : {}),
      ...(config.cwd
        ? { cwd: expandPiMcpString(config.cwd, name, 'cwd', resolution) }
        : {}),
    };
  }
  if (config.url) {
    return {
      type: 'http',
      url: expandPiMcpString(config.url, name, 'url', resolution),
      ...(config.headers
        ? { headers: expandPiMcpRecord(config.headers, name, 'headers', resolution) }
        : {}),
      ...(config.auth
        ? {
            oauth: {
              clientId: expandPiMcpString(
                config.auth.CLIENT_ID,
                name,
                'auth.CLIENT_ID',
                resolution,
              ),
              ...(config.auth.CLIENT_SECRET !== undefined
                ? {
                    clientSecret: expandPiMcpString(
                      config.auth.CLIENT_SECRET,
                      name,
                      'auth.CLIENT_SECRET',
                      resolution,
                    ),
                  }
                : {}),
              ...(config.auth.scopes?.length
                ? {
                    scope: config.auth.scopes
                      .map((value, index) =>
                        expandPiMcpString(
                          value,
                          name,
                          `auth.scopes[${index}]`,
                          resolution,
                        ),
                      )
                      .join(' '),
                  }
                : {}),
            },
          }
        : {}),
    };
  }
  throw new Error(
    `MCP server "${name}" has no command or URL. ` +
      'Use a valid resolved stdio or streamable HTTP configuration.',
  );
}

function expandPiMcpRecord(
  values: Record<string, string>,
  server: string,
  field: string,
  resolution: Required<PiMcpConfigResolutionOptions>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      expandPiMcpString(value, server, `${field}.${key}`, resolution),
    ]),
  );
}

function expandPiMcpString(
  value: string,
  server: string,
  field: string,
  resolution: Required<PiMcpConfigResolutionOptions>,
): string {
  return value.replace(
    /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{workspaceFolder(Basename)?\}/g,
    (placeholder, variable: string | undefined, basenameSuffix: string | undefined) => {
      if (variable) {
        const resolved = resolution.env[variable];
        if (resolved === undefined) {
          throw new Error(
            `MCP server "${server}" references missing environment variable "${variable}" in ${field}.`,
          );
        }
        return resolved;
      }
      return basenameSuffix ? basename(resolution.cwd) : resolution.cwd;
    },
  );
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
  ...headers: Array<Record<string, string | null> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headerSet of headers) {
    if (!headerSet) continue;
    for (const [name, value] of Object.entries(headerSet)) {
      if (value !== null) merged[name] = value;
    }
  }
  return merged;
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
