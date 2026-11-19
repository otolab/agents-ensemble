import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
  getModel,
  getModels,
  getProviders,
} from '@earendil-works/pi-ai/compat';
import {
  createAssistantMessageEventStream,
  getSupportedThinkingLevels,
  type AssistantMessageEvent,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { ModelsError } from '@earendil-works/pi-ai/models';
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  type ModelRuntimeAuthOverrides,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  type ExtensionUIContext,
  type LoadedMcpConfig,
  type McpServerConfig as PiMcpServerConfig,
  type SessionMessageEntry,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import {
  createPiConductorAuthContext,
  hasPiConductorCommandCredential,
  preparePiConductorCommandAuthForRequest,
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
import { markConductorAgentFactoryCleanupIncomplete } from './conductor-agent-factory-cleanup.js';
import { toPiCodingAgentTools } from './conductor-tool-pi-adapter.js';
import {
  getPiHeadlessSettingsManagerOverrides,
  getPiHeadlessSetting,
  getPiSkillsDiscoverySettingsOverrides,
  type PiHeadlessSettingsManagerOverrides,
} from './pi-headless-settings.js';
import {
  expandPiResourcePrompt,
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
  resolveMcpServerConfigMapPlaceholders,
  type McpServerConfigMap,
} from '../mcp/load-mcp-config.js';

export const PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE =
  'agents-ensemble/conductor-message-history/v1';

interface PiSendState {
  runId: string;
  callbacks?: ConductorSendCallbacks;
  finalMessage?: AssistantMessage;
  usage?: ConductorTokenUsage;
  history?: ConductorSendCallbacks['history'];
}

interface PiMcpStartupState {
  error?: string;
}

interface PiMcpLifecycleState {
  enabled: boolean;
}

interface PiCommandAuthRequestGate {
  active: boolean;
}

const PI_MCP_STARTUP_OBSERVATION_MS = 2_000;
const PI_COMMAND_RESOLUTION_ERROR_MESSAGE =
  'API key auth failed for provider: failed to resolve API key for Pi provider from the configured command.';
const PI_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface PiResolvedModel {
  provider: string;
  modelId: string;
  model: Model<any>;
  usesModelRegistry?: boolean;
  apiKey?: string;
}

export type PiModelDetailsContextWindowSource =
  | 'pi-ai'
  | 'models.json'
  | 'pi-custom-model-default'
  | 'unavailable';

export interface PiResolvedModelDetails {
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  contextWindowSource: PiModelDetailsContextWindowSource;
  maxTokens: number | null;
  modelSource: 'pi-ai' | 'models.json';
  selection: {
    model: string;
    provider: string;
  };
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

/**
 * Resolve the local model metadata used by the Pi conductor without resolving
 * credentials or loading executable Pi resources.
 */
export async function resolvePiModelDetails(
  options: PiResourceLoaderOptions & {
    modelId?: string;
    provider?: string;
  },
): Promise<PiResolvedModelDetails> {
  const resources = await loadPiResources({
    ...options,
    loadExtensions: false,
    loadPromptResources: false,
    loadSkillContents: false,
  });
  const selection = resolvePiModelSelection(
    options.modelId,
    resources.settings,
    resources.models,
    options.provider,
  );
  const providerConfig = resources.models.providers[selection.provider];
  const definition = providerConfig?.models?.find(
    (candidate) => candidate.id === selection.modelId,
  );
  const override = providerConfig?.modelOverrides?.[selection.modelId];
  const builtInModel = getModel(
    selection.provider as never,
    selection.modelId as never,
  ) as Model<any> | undefined;
  const model = resolvePiModel(
    selection.provider,
    selection.modelId,
    providerConfig,
    builtInModel,
  );

  if (!model) {
    throw new Error(
      `Pi model "${selection.provider}/${selection.modelId}" was not found in the local Pi model catalog or models.json.`,
    );
  }

  const contextWindow =
    typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)
      ? model.contextWindow
      : null;
  const contextWindowSource: PiModelDetailsContextWindowSource =
    contextWindow === null
      ? 'unavailable'
      : override?.contextWindow !== undefined
        ? 'models.json'
        : definition?.contextWindow !== undefined
          ? 'models.json'
          : definition
            ? 'pi-custom-model-default'
            : 'pi-ai';
  const maxTokens =
    typeof model.maxTokens === 'number' && Number.isFinite(model.maxTokens)
      ? model.maxTokens
      : null;

  return {
    provider: selection.provider,
    id: selection.modelId,
    name: model.name || selection.modelId,
    contextWindow,
    contextWindowSource,
    maxTokens,
    modelSource: definition ? 'models.json' : 'pi-ai',
    selection: {
      model: selection.modelSource,
      provider: selection.providerSource,
    },
  };
}

async function resolvePiModelConfigFromResources(
  options: PiResourceLoaderOptions & {
    modelId?: string;
    apiKey?: string;
  },
  resources: PiResources,
  authContext: Awaited<ReturnType<typeof createPiConductorAuthContext>>,
  commandAuthRequestGate?: PiCommandAuthRequestGate,
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
  const commandAuthConfigured =
    options.apiKey === undefined &&
    hasPiConductorCommandCredential(resources, selection.provider, env);
  const apiKey = commandAuthConfigured
    ? undefined
    : await resolvePiConductorApiKey({
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

  if (commandAuthConfigured) {
    // Pi calls hasConfiguredAuth() during prompt setup and getAuth() just
    // before sending a provider request. Keep the command out of setup and
    // defer registration/resolution until the latter, while preserving Pi's
    // own auth resolver and precedence.
    installPiCommandAuthRequestGate({
      modelRuntime: authContext.modelRuntime,
      resources,
      provider: selection.provider,
      env,
      gate: commandAuthRequestGate ?? { active: false },
    });
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

  constructor(
    private readonly session: AgentSession,
    private readonly resources: PiResources,
    private readonly settingsManager: SettingsManager,
    private readonly headlessSettingsOverrides: PiHeadlessSettingsManagerOverrides,
    private readonly systemPromptRef: { value: string },
    public readonly agentId: string,
    private readonly modelId: string,
    private readonly mcpStartupState: PiMcpStartupState,
    private readonly mcpLifecycleState: PiMcpLifecycleState,
    private readonly commandAuthRequestGate: PiCommandAuthRequestGate,
    private readonly piSkills: boolean,
    private readonly piPromptResources: boolean,
    private readonly onStreamText?: (text: string) => void,
    private readonly onContextCompaction?: () => void,
    private readonly onRetryEvent?: ConductorAgentCreateOptions['onRetryEvent'],
    private readonly onCompactionEvent?: ConductorAgentCreateOptions['onCompactionEvent'],
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

    const state: PiSendState = {
      runId,
      callbacks,
      ...(callbacks?.history ? { history: callbacks.history } : {}),
    };
    this.activeSend = state;
    try {
      await this.session.prompt(
        this.piPromptResources
          ? expandPiResourcePrompt(prompt, this.resources, {
              expandSkills: !this.piSkills,
            })
          : prompt,
        {
          expandPromptTemplates: false,
          source: 'rpc',
        },
      );
    } catch (error) {
      return {
        runId,
        status: 'error',
        error: {
          message: piConductorErrorMessage(error),
          ...(error instanceof ModelsError ? { code: error.code } : {}),
        },
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

    sanitizePiAssistantMessageInPlace(finalMessage);
    const status = statusFromStopReason(finalMessage.stopReason);
    const result = assistantText(finalMessage) || undefined;
    if (
      status === 'finished' &&
      result?.trim() &&
      state.history &&
      state.history.dispatchSource !== 'initial'
    ) {
      appendPiConductorMessageHistory(this.session.sessionManager, {
        history: state.history,
        responseText: result,
        completedAt: Date.now(),
      });
    }
    return {
      runId,
      status,
      result,
      ...(finalMessage.errorMessage
        ? { error: { message: finalMessage.errorMessage } }
        : {}),
      usage: state.usage ?? toConductorTokenUsage(finalMessage.usage),
      modelId: finalMessage.model || this.modelId,
    };
  }

  async reload(): Promise<void> {
    let sessionReloadFailed = false;
    let sessionReloadError: unknown;
    let snapshotRestoreFailed = false;
    let snapshotRestoreError: unknown;

    try {
      await this.session.reload();
    } catch (error) {
      sessionReloadFailed = true;
      sessionReloadError = error;
    } finally {
      // AgentSession.reload() reloads the SDK settings manager. Reapply the
      // conductor's allowlisted snapshot even when a later resource/extension
      // reload step rejects, so a failed reload cannot leave a live session
      // with an empty or SDK-file-derived settings manager.
      try {
        applyPiHeadlessSettings(
          this.settingsManager,
          this.headlessSettingsOverrides,
        );
      } catch (error) {
        snapshotRestoreFailed = true;
        snapshotRestoreError = error;
      }
    }

    if (sessionReloadFailed || snapshotRestoreFailed) {
      // AgentSession does not provide a transactional reload. Once either the
      // SDK reload or snapshot restoration fails, discard this object and let
      // the caller create/resume a fresh session with a clean lifecycle.
      let closeError: unknown;
      try {
        await this.close();
      } catch (error) {
        closeError = error;
      }
      throwReloadFailure(sessionReloadError, snapshotRestoreError, closeError);
    }
  }

  async getUsage(): Promise<ConductorAgentUsage> {
    // Pi's AssistantMessage.usage.cost is calculated from the model's configured
    // token rates. It is not a provider billing record, so it must not enter the
    // shared charged-cost field used by session usage and exit summaries.
    return {};
  }

  async cancel(): Promise<void> {
    if (this.activeSend) {
      await this.session.abort();
    }
  }

  /** Resume recompiles and reinstalls the native system prompt on each run. */
  async setSystemPrompt(systemPrompt: string): Promise<void> {
    this.systemPromptRef.value = systemPrompt;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      try {
        await this.session.abort();
      } catch (error) {
        errors.push(error);
      }
      try {
        try {
          this.unsubscribe();
        } catch (error) {
          errors.push(error);
        }
        if (this.mcpLifecycleState.enabled) {
          // AgentSession.dispose() invalidates extension contexts but does not
          // emit Pi's awaited session_shutdown event. Reload once with MCP
          // disabled so the official extension closes its stdio transports
          // before disposal without starting replacement children.
          this.mcpLifecycleState.enabled = false;
          try {
            await this.session.reload();
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        try {
          this.session.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Pi conductor session cleanup failed.');
      }
    })();
    return this.closePromise;
  }

  async closeForResume(): Promise<void> {
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
          try {
            if (this.mcpLifecycleState.enabled) {
              // Pi dispose does not await MCP extension shutdown. Disable MCP
              // and reload once so its stdio children close before disposal.
              this.mcpLifecycleState.enabled = false;
              await this.session.reload();
            }
          } finally {
            this.session.dispose();
          }
        }
      }
    })();
    return this.closePromise;
  }

  private handleEvent(event: AgentSessionEvent): void {
    const activeSend = this.activeSend;
    if (
      (event.type === 'message_start' ||
        event.type === 'message_update' ||
        event.type === 'message_end') &&
      event.message.role === 'assistant'
    ) {
      // AgentSession emits public listeners before appending message_end to the
      // Pi transcript. Mutating this message keeps the event and persisted entry
      // safe if a failure came from a nonstandard Pi stream path.
      sanitizePiAssistantMessageInPlace(event.message);
    }

    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      // Observers must not interfere with the Pi session or its send lifecycle.
      try {
        if (event.type === 'compaction_start') {
          this.onCompactionEvent?.({ type: 'start', reason: event.reason });
        } else {
          this.onCompactionEvent?.({
            type: 'end', reason: event.reason,
            outcome: event.aborted ? 'aborted' : event.errorMessage != null || event.result == null ? 'failed' : 'success',
            ...(event.result ? { tokensBefore: event.result.tokensBefore } : {}),
            ...(event.errorMessage != null ? { errorMessage: event.errorMessage } : {}),
          });
        }
      } catch {
        // Observational callbacks cannot stop compaction or dispatch.
      }
    }

    if (
      event.type === 'compaction_end' &&
      event.result != null &&
      !event.aborted &&
      event.errorMessage == null
    ) {
      this.onContextCompaction?.();
      return;
    }

    if (
      event.type === 'auto_retry_start' || event.type === 'auto_retry_end' ||
      event.type === 'summarization_retry_scheduled' ||
      event.type === 'summarization_retry_attempt_start' ||
      event.type === 'summarization_retry_finished'
    ) {
      // Retry notifications are observational and must not disrupt the session.
      try {
        this.onRetryEvent?.(event);
      } catch {
        // Ignore observer failures.
      }
      return;
    }

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

    if (event.type === 'agent_end') {
      for (const message of event.messages) {
        if (message.role === 'assistant') sanitizePiAssistantMessageInPlace(message);
      }
    }

    if (event.type === 'agent_end' && activeSend) {
      activeSend.finalMessage = lastAssistantMessage(event.messages);
      for (const message of event.messages) {
        if (message.role === 'assistant') {
          activeSend.usage = addConductorTokenUsage(
            activeSend.usage,
            message.usage,
          );
        }
      }
    }
  }
}

function installPiCommandAuthRequestGate(input: {
  modelRuntime: ModelRuntime;
  resources: PiResources;
  provider: string;
  env: NodeJS.ProcessEnv;
  gate: PiCommandAuthRequestGate;
}): void {
  const originalHasConfiguredAuth =
    input.modelRuntime.hasConfiguredAuth.bind(input.modelRuntime);
  input.modelRuntime.hasConfiguredAuth = (provider: string) =>
    provider === input.provider || originalHasConfiguredAuth(provider);

  const originalGetAuth = input.modelRuntime.getAuth.bind(input.modelRuntime);
  input.modelRuntime.getAuth = (async (
    providerOrModel: string | Model<any>,
    overrides?: ModelRuntimeAuthOverrides,
  ) => {
    const provider =
      typeof providerOrModel === 'string'
        ? providerOrModel
        : providerOrModel.provider;
    if (
      provider !== input.provider ||
      !input.gate.active ||
      overrides?.apiKey !== undefined
    ) {
      return originalGetAuth(providerOrModel as never, overrides);
    }

    await preparePiConductorCommandAuthForRequest({
      modelRuntime: input.modelRuntime,
      resources: input.resources,
      provider: input.provider,
      env: input.env,
    });
    try {
      return await originalGetAuth(providerOrModel as never, overrides);
    } catch (error) {
      if (isPiCommandResolutionError(error)) {
        throw new Error(PI_COMMAND_RESOLUTION_ERROR_MESSAGE);
      }
      throw error;
    }
  }) as ModelRuntime['getAuth'];

  const originalStreamSimple = input.modelRuntime.streamSimple.bind(
    input.modelRuntime,
  );
  input.modelRuntime.streamSimple = ((
    model: Model<any>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => {
    if (model.provider !== input.provider) {
      return originalStreamSimple(model, context, options);
    }

    // Pi 1.2.0's lazy stream starts its setup synchronously. That setup calls
    // prepareRequest(), which starts getAuth() before streamSimple() returns.
    // Keep the command gate active only for that setup call: prompt hooks and
    // the provider response stream itself must not trigger command resolution
    // through an unrelated getAuth() lookup.
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        const wasActive = input.gate.active;
        let response: ReturnType<ModelRuntime['streamSimple']>;
        input.gate.active = true;
        try {
          response = originalStreamSimple(model, context, options);
        } finally {
          input.gate.active = wasActive;
        }
        let terminalEventSeen = false;
        for await (const event of response) {
          if (event.type === 'done' || event.type === 'error') {
            terminalEventSeen = true;
          }
          output.push(sanitizePiAssistantEvent(event));
        }
        if (!terminalEventSeen) {
          output.end(sanitizePiAssistantMessage(await response.result()));
        }
      } catch (error) {
        output.push({
          type: 'error',
          reason: 'error',
          error: createPiRequestFailureMessage(
            model,
            piConductorErrorMessage(error),
          ),
        });
      }
    })();
    return output;
  }) as ModelRuntime['streamSimple'];
}

function sanitizePiAssistantEvent(
  event: AssistantMessageEvent,
): AssistantMessageEvent {
  if (event.type === 'done') {
    return { ...event, message: sanitizePiAssistantMessage(event.message) };
  }
  if (event.type === 'error') {
    return { ...event, error: sanitizePiAssistantMessage(event.error) };
  }
  if ('partial' in event) {
    return { ...event, partial: sanitizePiAssistantMessage(event.partial) };
  }
  return event;
}

function sanitizePiAssistantMessage(
  message: AssistantMessage,
): AssistantMessage {
  if (!message.errorMessage) return message;
  const safeErrorMessage = sanitizePiCommandResolutionMessage(
    message.errorMessage,
  );
  return safeErrorMessage === message.errorMessage
    ? message
    : { ...message, errorMessage: safeErrorMessage };
}

function sanitizePiAssistantMessageInPlace(message: AssistantMessage): void {
  if (!message.errorMessage) return;
  message.errorMessage = sanitizePiCommandResolutionMessage(
    message.errorMessage,
  );
}

function sanitizePiCommandResolutionMessage(message: string): string {
  return isPiCommandResolutionError(message)
    ? PI_COMMAND_RESOLUTION_ERROR_MESSAGE
    : message;
}

function createPiRequestFailureMessage(
  model: Model<any>,
  errorMessage: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'error',
    errorMessage: sanitizePiCommandResolutionMessage(errorMessage),
    timestamp: Date.now(),
  };
}

function appendPiConductorMessageHistory(
  sessionManager: SessionManager,
  input: {
    history: NonNullable<ConductorSendCallbacks['history']>;
    responseText: string;
    completedAt: number;
  },
): void {
  const branch = sessionManager.getBranch();
  let assistantIndex = -1;
  let assistantEntry: SessionMessageEntry | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry?.type === 'message' &&
      entry.message.role === 'assistant' &&
      piMessageText(entry).trim() === input.responseText.trim()
    ) {
      assistantIndex = index;
      assistantEntry = entry;
      break;
    }
  }
  if (!assistantEntry) {
    throw new Error(
      'Pi conductor history could not locate the final assistant entry on the active branch.',
    );
  }

  let userEntry: SessionMessageEntry | undefined;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === 'message' && entry.message.role === 'user') {
      userEntry = entry;
      break;
    }
  }
  if (!userEntry) {
    throw new Error(
      'Pi conductor history could not locate the matching user entry on the active branch.',
    );
  }

  sessionManager.appendCustomEntry(PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE, {
    inboundEntryId: userEntry.id,
    responseEntryId: assistantEntry.id,
    completedAt: input.completedAt,
    sendCount: input.history.sendCount,
    ...(input.history.dispatchSource
      ? { dispatchSource: input.history.dispatchSource }
      : {}),
  });
}

function piMessageText(entry: SessionMessageEntry): string {
  const message = entry.message;
  if (message.role !== 'user' && message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

/** Create the Pi conductor backend factory. */
export function createPiConductorAgentFactory(): ConductorAgentFactory {
  return {
    create: (options) => PiConductorAgent.create(options),
    resume: (agentId, options) => PiConductorAgent.resume(agentId, options),
  };
}

function resolvePiConductorThinkingLevel(
  model: Model<any>,
  provider: string,
  modelId: string,
  value: string,
): ThinkingLevel {
  const reasoning = value.trim();
  if (!reasoning) {
    throw new Error('Pi conductor reasoning must be a non-empty string.');
  }
  if (!PI_THINKING_LEVELS.includes(reasoning as ThinkingLevel)) {
    throw new Error(
      `Pi conductor reasoning "${reasoning}" is invalid. Supported Pi levels: ${PI_THINKING_LEVELS.join(', ')}.`,
    );
  }

  if (
    (model.api === 'google-generative-ai' || model.api === 'google-vertex') &&
    /^gemini-4(?:[.-]|$)/i.test(model.id)
  ) {
    throw new Error(
      `Pi conductor reasoning cannot be applied to Google Gemini 4 model "${provider}/${modelId}" with Pi 1.2.0: ` +
        'the Google adapter does not select Gemini’s thinkingLevel request format for Gemini 4.',
    );
  }

  const supportedLevels = getSupportedThinkingLevels(model);
  if (!supportedLevels.includes(reasoning as ThinkingLevel)) {
    throw new Error(
      `Pi conductor model "${provider}/${modelId}" does not support reasoning level "${reasoning}". ` +
        `Supported levels: ${supportedLevels.join(', ')}.`,
    );
  }
  return reasoning as ThinkingLevel;
}

type PiSessionStartReason = 'startup' | 'resume';

function resolvePiConductorSessionDir(
  options: ConductorAgentCreateOptions,
): string {
  if (options.sessionDir !== undefined) return options.sessionDir;
  if (!options.issueUrl) {
    throw new Error(
      'Pi conductor transcript storage requires issueUrl or an explicit sessionDir.',
    );
  }
  return resolveEnsemblePaths({ repoRoot: options.cwd })
    .canonicalPiSessionsDir(options.issueUrl);
}

async function createPiConductorSession(
  agentId: string,
  options: ConductorAgentCreateOptions,
  reason: PiSessionStartReason,
): Promise<PiConductorAgent> {
  const sessionDir = resolvePiConductorSessionDir(options);
  const piInternalExtensions = options.piInternalExtensions !== false;
  const operatorDirectMcp = options.operatorPiMcpMode === 'direct';
  const piMcpResolution = {
    cwd: options.cwd,
    ...(operatorDirectMcp
      ? { exposure: 'direct' as const, autoEnableCodemode: false }
      : {}),
  };
  const mcpLifecycleState: PiMcpLifecycleState = {
    enabled:
      piInternalExtensions && Object.keys(options.mcpServers ?? {}).length > 0,
  };
  // Validate the harness-resolved map before creating the SDK session so an
  // unsupported transport fails with an actionable Pi-specific error.
  if (piInternalExtensions && options.mcpServers) {
    loadPiMcpConfig(options.mcpServers, piMcpResolution);
  }
  const piSkills = options.piSkills !== false;
  const piPromptResources = options.piPromptResources !== false;
  const resources = await loadPiResources({
    ...options,
    loadExtensions: options.piExtensions !== false,
    loadPromptResources: piPromptResources,
    loadSkillContents: !piSkills,
  });
  const headlessSettingsOverrides = getPiHeadlessSettingsManagerOverrides(resources.settings);
  const authContext = await createPiConductorAuthContext(options, resources);
  const commandAuthRequestGate: PiCommandAuthRequestGate = { active: false };
  const resolved = await resolvePiModelConfigFromResources(
    options,
    resources,
    authContext,
    commandAuthRequestGate,
  );
  const thinkingLevel =
    options.reasoning !== undefined
      ? resolvePiConductorThinkingLevel(
          resolved.model,
          resolved.provider,
          resolved.modelId,
          options.reasoning,
        )
      : undefined;
  if (options.apiKey !== undefined) {
    await authContext.modelRuntime.setRuntimeApiKey(resolved.provider, options.apiKey);
  }

  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  let sessionManager: SessionManager;
  let previousSessionFile: string | undefined;
  if (reason === 'resume') {
    const resumeCwds = [
      ...new Set([options.cwd, ...(options.resumeCwds ?? [])]),
    ];
    const findSessionFile = (directory: string) => {
      for (const cwd of resumeCwds) {
        const sessionFile = SessionManager.findById(cwd, agentId, directory);
        if (sessionFile) return sessionFile;
      }
      return undefined;
    };
    previousSessionFile = findSessionFile(sessionDir);
    if (!previousSessionFile) {
      throw new Error(
        `Pi session not found for resume (sessionId=${agentId}, cwd=${options.cwd}, ` +
          `sessionsRoot=${sessionDir})`,
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
    value: options.systemPrompt,
  };
  // Pi's file-backed SettingsManager reads both agentDir/settings.json and
  // <cwd>/.pi/settings.json. The conductor has a different resource contract
  // (.ensemble/pi), so use an in-memory manager and populate it only through
  // the code-level headless settings allowlist below.
  const settingsManager = SettingsManager.inMemory();
  if (piSkills && piPromptResources) {
    applyPiHeadlessSettings(
      settingsManager,
      getPiSkillsDiscoverySettingsOverrides(resources.settings),
    );
    settingsManager.setProjectTrusted(true);
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: authContext.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: !piSkills || !piPromptResources,
    additionalSkillPaths:
      piSkills && piPromptResources ? resources.skillPaths : [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: systemPromptRef.value,
    extensionFactories: [
      ...(piInternalExtensions
        ? [
            createMcpExtension({
              loadConfig: () =>
                loadPiMcpConfig(
                  mcpLifecycleState.enabled ? options.mcpServers : undefined,
                  piMcpResolution,
                ),
            }),
            ...(operatorDirectMcp
              ? []
              : [createCodemodeExtension({ mode: 'on' })]),
            createToolSearchExtension(),
          ]
        : []),
      createPiSystemPromptExtension(systemPromptRef),
    ],
  });
  await resourceLoader.reload();
  applyPiHeadlessSettings(settingsManager, headlessSettingsOverrides);

  let session: AgentSession | undefined;
  try {
    const mcpStartupState: PiMcpStartupState = {};
    const result = await createAgentSession({
      cwd: options.cwd,
      agentDir: authContext.agentDir,
      modelRuntime: authContext.modelRuntime,
      model: resolved.model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
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
    await observePiMcpStartup(
      session,
      piInternalExtensions ? options.mcpServers : undefined,
      mcpStartupState,
    );
    if (mcpStartupState.error) {
      throw new Error(mcpStartupState.error);
    }
    return new PiConductorAgent(
      session,
      resources,
      settingsManager,
      headlessSettingsOverrides,
      systemPromptRef,
      agentId,
      resolved.modelId,
      mcpStartupState,
      mcpLifecycleState,
      commandAuthRequestGate,
      piSkills,
      piPromptResources,
      options.onStreamText,
      options.onContextCompaction,
      options.onRetryEvent,
      options.onCompactionEvent,
    );
  } catch (error) {
    if (!session) throw error;
    const cleanupErrors: unknown[] = [];
    if (mcpLifecycleState.enabled) {
      mcpLifecycleState.enabled = false;
      try {
        await session.reload();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      session.dispose();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length === 0) throw error;
    throw markConductorAgentFactoryCleanupIncomplete(
      new AggregateError(
        [error, ...cleanupErrors],
        'Pi conductor startup failed and session cleanup was incomplete.',
      ),
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function applyPiHeadlessSettings(
  settingsManager: SettingsManager,
  overrides: PiHeadlessSettingsManagerOverrides,
): void {
  type SettingsOverrides = Parameters<SettingsManager['applyOverrides']>[0];
  settingsManager.applyOverrides(overrides as SettingsOverrides);
}

function throwReloadFailure(
  sessionReloadError: unknown,
  snapshotRestoreError: unknown,
  closeError: unknown,
): never {
  const errors = [sessionReloadError, snapshotRestoreError, closeError].filter(
    (error): error is unknown => error !== undefined,
  );
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'Pi conductor session reload failed and the session was closed.');
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
  const resolvedServers = resolveMcpServerConfigMapPlaceholders(
    servers ?? {},
    resolution,
  );
  return {
    servers: Object.entries(resolvedServers).map(([name, config]) => ({
      name,
      config: toPiMcpServerConfig(name, config, options.exposure),
      source: '<agents-ensemble-resolved-mcp.json>',
      scope: 'project' as const,
    })),
    autoEnableCodemode: options.autoEnableCodemode ?? true,
    errors: [],
  };
}

export interface PiMcpConfigResolutionOptions {
  /** Workspace used for Cursor's `${workspaceFolder}` placeholders. */
  cwd?: string;
  /** Environment used for Cursor's `${env:NAME}` placeholders. */
  env?: NodeJS.ProcessEnv;
  /** Pi MCP tool exposure override. Operator-agent uses direct exposure. */
  exposure?: 'direct';
  /** Whether Pi should activate Codemode for MCP servers with Codemode exposure. */
  autoEnableCodemode?: boolean;
}

function toPiMcpServerConfig(
  name: string,
  config: McpServerConfigMap[string],
  exposure?: 'direct',
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
      command: config.command,
      ...(config.args
        ? { args: config.args }
        : {}),
      ...(config.env ? { env: config.env } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(exposure ? { exposure } : {}),
    };
  }
  if (config.url) {
    return {
      type: 'http',
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
      ...(exposure ? { exposure } : {}),
      ...(config.auth
        ? {
            oauth: {
              clientId: config.auth.CLIENT_ID,
              ...(config.auth.CLIENT_SECRET !== undefined
                ? {
                    clientSecret: config.auth.CLIENT_SECRET,
                  }
                : {}),
              ...(config.auth.scopes?.length
                ? {
                    scope: config.auth.scopes.join(' '),
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
  requestedProvider?: string,
): {
  provider: string;
  modelId: string;
  modelSource: string;
  providerSource: string;
} {
  const requested = normalizeConfiguredString(requestedModelId);
  const configuredCandidates = [
    {
      key: 'defaultModel',
      value: getPiHeadlessSetting(settings, 'defaultModel', 'model-selection'),
    },
    {
      key: 'model',
      value: getPiHeadlessSetting(settings, 'model', 'model-selection'),
    },
    {
      key: 'modelId',
      value: getPiHeadlessSetting(settings, 'modelId', 'model-selection'),
    },
  ] as const;
  const configured = configuredCandidates.find(
    (candidate) => normalizeConfiguredString(candidate.value) !== undefined,
  );
  const selected = requested ?? normalizeConfiguredString(configured?.value);
  const modelSource = requested
    ? 'requested'
    : configured
      ? `settings.${configured.key}`
      : 'settings';
  const configuredProvider = normalizeConfiguredString(
    getPiHeadlessSetting(settings, 'defaultProvider', 'model-selection'),
  );
  const explicitProvider = normalizeConfiguredString(requestedProvider);
  let provider: string | undefined;
  let providerSource: string;
  let modelId = selected;

  if (selected?.includes('/')) {
    const slash = selected.indexOf('/');
    const qualifiedProvider = selected.slice(0, slash);
    if (explicitProvider && explicitProvider !== qualifiedProvider) {
      throw new Error(
        `Pi model "${selected}" conflicts with --provider "${explicitProvider}".`,
      );
    }
    provider = qualifiedProvider;
    providerSource = requested ? 'qualified-model' : modelSource;
    modelId = selected.slice(slash + 1);
  } else if (explicitProvider) {
    provider = explicitProvider;
    providerSource = 'provider-option';
  } else if (configuredProvider) {
    provider = configuredProvider;
    providerSource = 'settings.defaultProvider';
  } else {
    providerSource = 'unique-model-match';
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
    if (matches.length === 1) {
      provider = matches[0];
    } else if (matches.length > 1) {
      throw new Error(
        `Pi model "${modelId}" exists under multiple providers: ${matches.join(', ')}. ` +
          'Specify provider/model or pass --provider <id>.',
      );
    } else {
      throw new Error(
        `Pi model "${modelId}" was not found in the local Pi model catalog or models.json. ` +
          'Use a known model ID or specify provider/model.',
      );
    }
  }

  if (!provider) {
    throw new Error(
      `Pi provider is not configured for model "${modelId}". Set defaultProvider in Pi settings.json or use provider/model.`,
    );
  }

  return { provider, modelId, modelSource, providerSource };
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

function addConductorTokenUsage(
  current: ConductorTokenUsage | undefined,
  usage: AssistantMessage['usage'],
): ConductorTokenUsage {
  const next = toConductorTokenUsage(usage);
  if (!current) return next;

  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    cacheReadTokens:
      (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens:
      (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function piConductorErrorMessage(error: unknown): string {
  if (isPiCommandResolutionError(error)) {
    return PI_COMMAND_RESOLUTION_ERROR_MESSAGE;
  }
  return error instanceof Error ? error.message : String(error);
}

function isPiCommandResolutionError(error: unknown): boolean {
  if (
    typeof error === 'string' &&
    /failed to resolve api key|from shell command/i.test(error)
  ) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  if (error instanceof ModelsError && error.code !== 'auth') return false;
  const isAuthModelsError = error instanceof ModelsError && error.code === 'auth';
  const errorMessage =
    'message' in error && typeof error.message === 'string' ? error.message : '';
  if (/failed to resolve api key|from shell command/i.test(errorMessage)) {
    return true;
  }
  const topLevelDetails = error as ModelsError & {
    stdout?: unknown;
    stderr?: unknown;
  };
  if (
    isAuthModelsError &&
    (topLevelDetails.stdout !== undefined || topLevelDetails.stderr !== undefined)
  ) {
    return true;
  }

  const pending: unknown[] = [(error as { cause?: unknown }).cause];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const cause = pending.pop();
    if (!cause || typeof cause !== 'object' || seen.has(cause)) continue;
    seen.add(cause);
    const details = cause as {
      cause?: unknown;
      message?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (
      isAuthModelsError &&
      (details.stdout !== undefined || details.stderr !== undefined)
    ) {
      return true;
    }
    if (
      typeof details.message === 'string' &&
      /failed to resolve api key|from shell command/i.test(details.message)
    ) {
      return true;
    }
    pending.push(details.cause);
  }
  return false;
}
