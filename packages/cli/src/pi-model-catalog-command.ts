import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createPiConductorAuthContext,
  loadPiResources,
  resolvePiConductorApiKey,
  type PiModelDefinition,
  type PiProviderConfig,
} from '@agents-ensemble/core';
import type { ConductorCommandOptions } from './conductor-auth-command.js';
import { resolveConductorCommandContext } from './conductor-auth-command.js';

export type PiModelsSyncTarget = 'project' | 'user';

export interface PiRemoteModel {
  id: string;
  maxInputTokens?: number;
}

export interface PiModelsSyncResult {
  provider: string;
  apiOnly: PiRemoteModel[];
  jsonOnly: string[];
  shared: string[];
  added: string[];
  skipped: string[];
  targetPath?: string;
}

export interface RunPiModelsSyncOptions extends ConductorCommandOptions {
  provider?: string;
  target?: PiModelsSyncTarget;
  add?: string[];
  /** Injectable only for tests; production uses the global fetch implementation. */
  fetchImpl?: typeof fetch;
}

export async function runPiModelsSync(
  options: RunPiModelsSyncOptions,
): Promise<PiModelsSyncResult> {
  const provider = options.provider?.trim();
  if (!provider) {
    throw new Error('Pass --provider <id> to select a configured Pi provider.');
  }
  const requestedIds = [...new Set((options.add ?? []).map((id) => id.trim()))];
  if (requestedIds.some((id) => !id)) {
    throw new Error('Model IDs passed to --add must not be empty.');
  }
  if (requestedIds.length > 0 && !options.target) {
    throw new Error('Pass --target project or --target user when adding models.');
  }

  const context = await resolveConductorCommandContext(options);
  if (context.auth.backend !== 'pi' || !context.auth.pi) {
    throw new Error('Model catalog sync requires the Pi conductor backend.');
  }

  const piOptions = context.auth.pi;
  const resources = await loadPiResources(piOptions);
  const providerConfig = resources.models.providers[provider];
  if (!providerConfig) {
    throw new Error(`Pi provider "${provider}" is not configured in models.json.`);
  }
  if (!providerConfig.baseUrl) {
    throw new Error(`Pi provider "${provider}" needs a baseUrl in models.json.`);
  }
  if (!providerConfig.api?.startsWith('openai-')) {
    throw new Error(
      `Pi provider "${provider}" needs an OpenAI-compatible api (for example "openai-completions") in models.json.`,
    );
  }

  const authContext = await createPiConductorAuthContext(piOptions, resources);
  let apiKey: string | undefined;
  try {
    apiKey = await resolvePiConductorApiKey({
      modelRuntime: authContext.modelRuntime,
      resources,
      provider,
      env: piOptions.env ?? process.env,
    });
  } catch {
    // Credential resolver errors can include the configured !command. Keep
    // command output safe even when that configuration contains sensitive data.
    throw new Error(`Could not resolve credentials for Pi provider "${provider}".`);
  }

  const apiModels = await fetchPiRemoteModels({
    provider,
    config: providerConfig,
    apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const jsonModels = providerConfig.models ?? [];
  const jsonIds = new Set(jsonModels.map((model) => model.id));
  const apiIds = new Set(apiModels.map((model) => model.id));
  const apiOnly = apiModels.filter((model) => !jsonIds.has(model.id));
  const jsonOnly = [...jsonIds].filter((id) => !apiIds.has(id)).sort();
  const shared = [...apiIds].filter((id) => jsonIds.has(id)).sort();
  const result: PiModelsSyncResult = {
    provider,
    apiOnly,
    jsonOnly,
    shared,
    added: [],
    skipped: [],
  };

  if (requestedIds.length === 0) return result;

  const unknownIds = requestedIds.filter((id) => !apiIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `Cannot add model IDs that are not in the API catalog: ${unknownIds.join(', ')}.`,
    );
  }

  const targetRoot =
    options.target === 'project'
      ? resources.roots.projectDir
      : resources.roots.agentDir;
  const targetPath = join(targetRoot, 'models.json');
  const targetModelsFile = await readModelsFile(targetPath);
  const targetProviders = ensureObject(targetModelsFile.providers, 'providers', targetPath);
  const targetProviderConfig = ensureObject(
    targetProviders[provider],
    `providers.${provider}`,
    targetPath,
  );
  const targetModels = readModelDefinitions(
    targetProviderConfig.models,
    `providers.${provider}.models`,
    targetPath,
  );

  const projectLayerConfig = resources.modelsLayers.at(-1)?.providers[provider];
  if (
    options.target === 'user' &&
    resources.roots.agentDir !== resources.roots.projectDir &&
    projectLayerConfig?.models !== undefined &&
    requestedIds.some((id) => !jsonIds.has(id))
  ) {
    throw new Error(
      `Project models.json replaces the user model list for provider "${provider}". Use --target project so the added IDs appear in the Pi registry.`,
    );
  }

  const effectiveIds = new Set(jsonIds);
  const modelsForWrite =
    options.target === 'project'
      ? [...jsonModels]
      : [...targetModels];
  for (const id of requestedIds) {
    if (effectiveIds.has(id)) {
      result.skipped.push(id);
      continue;
    }
    const remoteModel = apiModels.find((model) => model.id === id)!;
    const definition: PiModelDefinition = {
      id,
      ...(remoteModel.maxInputTokens !== undefined
        ? { contextWindow: remoteModel.maxInputTokens }
        : {}),
    };
    modelsForWrite.push(definition);
    effectiveIds.add(id);
    result.added.push(id);
  }

  if (result.added.length > 0) {
    targetProviderConfig.models = modelsForWrite;
    targetProviders[provider] = targetProviderConfig;
    targetModelsFile.providers = targetProviders;
    await writeModelsFile(targetPath, targetModelsFile);
    result.targetPath = targetPath;
  }

  return result;
}

async function fetchPiRemoteModels(options: {
  provider: string;
  config: PiProviderConfig;
  apiKey?: string;
  fetchImpl: typeof fetch;
}): Promise<PiRemoteModel[]> {
  const url = buildModelsUrl(options.config.baseUrl!);
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.config.headers ?? {})) {
    if (typeof value === 'string') headers.set(name, value);
  }
  if (
    options.apiKey !== undefined &&
    options.config.authHeader === true
  ) {
    // Keep catalog auth aligned with Pi model requests: apiKey is attached
    // only when the provider explicitly opts into authHeader.
    headers.set('authorization', `Bearer ${options.apiKey}`);
  }

  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      `Could not fetch the model catalog for Pi provider "${options.provider}". Check its endpoint and network access.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Model catalog request for Pi provider "${options.provider}" failed with HTTP ${response.status}.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `Pi provider "${options.provider}" returned an invalid model catalog response.`,
    );
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(
      `Pi provider "${options.provider}" returned an invalid model catalog response.`,
    );
  }

  const models = new Map<string, PiRemoteModel>();
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '') continue;
    const id = item.id.trim();
    if (models.has(id)) continue;
    const maxInputTokens =
      typeof item.max_input_tokens === 'number' &&
      Number.isSafeInteger(item.max_input_tokens) &&
      item.max_input_tokens > 0
        ? item.max_input_tokens
        : undefined;
    models.set(id, {
      id,
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    });
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildModelsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Pi provider baseUrl must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Pi provider baseUrl must use HTTP or HTTPS.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  const apiPath = /\/v1$/i.test(path) ? path : `${path}/v1`;
  url.pathname = `${apiPath}/models`;
  return url.toString();
}

async function readModelsFile(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return { providers: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(source));
  } catch {
    throw new Error(`Cannot update invalid Pi models file ${path}.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot update Pi models file ${path}: expected a JSON object.`);
  }
  return parsed;
}

function readModelDefinitions(
  value: unknown,
  description: string,
  path: string,
): PiModelDefinition[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => !isRecord(entry) || typeof entry.id !== 'string')
  ) {
    throw new Error(`Cannot update ${description} in Pi models file ${path}.`);
  }
  return value as PiModelDefinition[];
}

function ensureObject(
  value: unknown,
  description: string,
  path: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`Cannot update ${description} in Pi models file ${path}.`);
  }
  return value;
}

async function writeModelsFile(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stripJsonComments(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      } else if (character === '\n') {
        output += character;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
