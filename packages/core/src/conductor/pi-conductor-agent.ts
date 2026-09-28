import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
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

interface PiSettingsFile {
  defaultProvider?: unknown;
  defaultModel?: unknown;
  model?: unknown;
  modelId?: unknown;
  apiKey?: unknown;
  apiKeys?: unknown;
}

type PiAuthFile = Record<string, unknown>;

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

/**
 * Minimal Pi file configuration used by the first in-process backend.
 *
 * The full `.ensemble/pi` ResourceLoader is intentionally left for #358. For
 * now only Pi's model selection and credential files are read, with the
 * ensemble paths taking precedence over Pi's standard paths.
 */
export async function resolvePiModelConfig(options: {
  cwd: string;
  modelId?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): Promise<PiResolvedModel> {
  const env = options.env ?? process.env;
  const roots = piConfigRoots(options.cwd, env, options.home ?? homedir());
  const settings = await readPiSettings(roots);
  const auth = await readPiAuth(roots);
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
    const resolved = await resolvePiModelConfig(options);
    const session = await PiConductorSession.create(options.cwd, agentId);
    return new PiConductorAgent(
      createPiAgent(agentId, options, resolved, session.messages),
      session,
      agentId,
      resolved.modelId,
      options.onStreamText,
    );
  }

  static async resume(
    agentId: string,
    options: ConductorAgentCreateOptions,
  ): Promise<PiConductorAgent> {
    const resolved = await resolvePiModelConfig(options);
    const session = await PiConductorSession.resume(options.cwd, agentId);
    return new PiConductorAgent(
      createPiAgent(agentId, options, resolved, session.messages),
      session,
      agentId,
      resolved.modelId,
      options.onStreamText,
    );
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
        this.unsubscribe();
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
      await this.session.appendMessages(event.messages);
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
): Agent {
  const tools = options.customTools
    ? toPiAgentTools(options.customTools)
    : [];

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

function piConfigRoots(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const userRoots = [
    join(home, '.pi', 'agent'),
    join(home, '.ensemble', 'pi'),
    ...(env.PI_CODING_AGENT_DIR ? [env.PI_CODING_AGENT_DIR] : []),
  ];
  const projectRoots = [
    join(cwd, '.pi'),
    join(cwd, '.ensemble', 'pi'),
  ];
  return [...new Set([...userRoots, ...projectRoots])];
}

async function readPiSettings(roots: string[]): Promise<PiSettingsFile> {
  let settings: PiSettingsFile = {};
  for (const root of roots) {
    const value = await readOptionalJson(join(root, 'settings.json'));
    if (value) {
      settings = { ...settings, ...value };
    }
  }
  return settings;
}

async function readPiAuth(roots: string[]): Promise<PiAuthFile> {
  let auth: PiAuthFile = {};
  for (const root of roots) {
    const value = await readOptionalJson(join(root, 'auth.json'));
    if (value) {
      auth = { ...auth, ...value };
    }
  }
  return auth;
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const source = await readFile(path, 'utf8');
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) {
      throw new Error(`Expected a JSON object in ${path}.`);
    }
    return value;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in Pi configuration file ${path}.`);
    }
    throw error;
  }
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

function isFileNotFound(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === 'ENOENT'
  );
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
