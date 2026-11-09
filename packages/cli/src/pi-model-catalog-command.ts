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

const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

type PiRemoteModelField = keyof Omit<PiRemoteModel, 'id'>;
type PiModelCatalogFieldSource =
  | 'openai-v1-models'
  | 'magpie-v1-models-reasoning'
  | 'litellm-model-group-info';
type PiModelCatalogEndpointId = 'openai-v1-models' | 'litellm-model-group-info';
type PiModelCatalogRow = Record<string, unknown>;
type PiModelCatalogFieldReader = (
  row: PiModelCatalogRow,
) => unknown | undefined;
type PiModelCatalogRowsReader = (payload: unknown) => unknown[] | undefined;

interface PiModelCatalogFieldSourceRegistration {
  id: PiModelCatalogFieldSource;
  providerIds?: readonly string[];
}

interface PiModelCatalogFieldSync {
  remoteField: PiRemoteModelField;
  piField: Exclude<keyof PiModelDefinition, 'id'>;
  add: boolean;
  refreshExisting: boolean;
  sources: Partial<
    Record<PiModelCatalogFieldSource, PiModelCatalogFieldReader>
  >;
  isEqual: (left: unknown, right: unknown) => boolean;
}

interface PiModelCatalogEndpointSource {
  id: PiModelCatalogEndpointId;
  providerIds?: readonly string[];
  buildUrl: (baseUrl: string) => string;
  readRows: PiModelCatalogRowsReader;
  modelIdField: string;
  addModelIds: boolean;
  required: boolean;
  fieldSources: readonly PiModelCatalogFieldSourceRegistration[];
  formatUnmatchedRequestedModelIdsWarning?: (
    ids: readonly string[],
  ) => string;
}

const PI_MODEL_CATALOG_ENDPOINTS: readonly PiModelCatalogEndpointSource[] = [
  {
    id: 'openai-v1-models',
    buildUrl: buildModelsUrl,
    readRows: readDataRows,
    modelIdField: 'id',
    addModelIds: true,
    required: true,
    fieldSources: [
      { id: 'openai-v1-models' },
      {
        id: 'magpie-v1-models-reasoning',
        providerIds: ['magpie'],
      },
    ],
  },
  {
    id: 'litellm-model-group-info',
    providerIds: ['litellm'],
    buildUrl: buildLiteLlmModelGroupInfoUrl,
    readRows: readDataRows,
    modelIdField: 'model_group',
    addModelIds: false,
    required: false,
    fieldSources: [{ id: 'litellm-model-group-info' }],
    formatUnmatchedRequestedModelIdsWarning: (ids) =>
      `LiteLLM GET /model_group/info has no exact model_group row for requested /v1/models ID(s): ${ids.join(', ')}. A caller/team alias may not include its canonical target in the API response; reasoning metadata was not synchronized and no alias mapping was inferred.`,
  },
];

const PI_MODEL_CATALOG_FIELD_SYNC: readonly PiModelCatalogFieldSync[] = [
  {
    remoteField: 'maxInputTokens',
    piField: 'contextWindow',
    add: true,
    refreshExisting: false,
    sources: {
      'openai-v1-models': (row) =>
        typeof row.max_input_tokens === 'number' &&
        Number.isSafeInteger(row.max_input_tokens) &&
        row.max_input_tokens > 0
          ? row.max_input_tokens
          : undefined,
    },
    isEqual: Object.is,
  },
  {
    remoteField: 'reasoning',
    piField: 'reasoning',
    add: true,
    refreshExisting: true,
    sources: {
      'magpie-v1-models-reasoning': readMagpieReasoning,
      'litellm-model-group-info': readLiteLlmReasoning,
    },
    isEqual: Object.is,
  },
  {
    remoteField: 'thinkingLevelMap',
    piField: 'thinkingLevelMap',
    add: true,
    refreshExisting: true,
    sources: {
      'magpie-v1-models-reasoning': (row) =>
        mapProviderThinkingLevels(readMagpieReasoningLevels(row)),
      'litellm-model-group-info': (row) =>
        mapProviderThinkingLevels(
          readStringArrayField(row, 'supported_reasoning_efforts'),
        ),
    },
    isEqual: sameThinkingLevelMap,
  },
];

export interface PiRemoteModel {
  id: string;
  maxInputTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface PiModelsSyncResult {
  provider: string;
  apiOnly: PiRemoteModel[];
  jsonOnly: string[];
  shared: string[];
  added: string[];
  skipped: string[];
  refreshed: string[];
  metadataWarnings?: string[];
  targetPath?: string;
}

export interface RunPiModelsSyncOptions extends ConductorCommandOptions {
  provider?: string;
  target?: PiModelsSyncTarget;
  add?: string[];
  refreshMetadata?: boolean;
  /** Injectable only for tests; production uses the global fetch implementation. */
  fetchImpl?: typeof fetch;
}

export async function runPiModelsRemote(
  options: RunPiModelsSyncOptions,
): Promise<{ provider: string; ids: string[] }> {
  const result = await comparePiModels(options);
  return {
    provider: result.provider,
    ids: [...result.apiOnly.map((model) => model.id), ...result.shared].sort(),
  };
}

export async function runPiModelsDiff(
  options: RunPiModelsSyncOptions,
): Promise<{ provider: string; apiOnly: string[]; jsonOnly: string[]; shared: string[] }> {
  const result = await comparePiModels(options);
  return {
    provider: result.provider,
    apiOnly: result.apiOnly.map((model) => model.id),
    jsonOnly: result.jsonOnly,
    shared: result.shared,
  };
}

export async function runPiModelsAdd(
  options: RunPiModelsSyncOptions,
  ids: string[],
): Promise<PiModelsSyncResult> {
  return runPiModelsCatalog({ ...options, add: ids });
}

export async function runPiModelsSync(
  options: RunPiModelsSyncOptions,
): Promise<PiModelsSyncResult> {
  return runPiModelsCatalog(options);
}

async function comparePiModels(options: RunPiModelsSyncOptions): Promise<PiModelsSyncResult> {
  return runPiModelsCatalog({ ...options, add: [] }, false);
}

async function runPiModelsCatalog(
  options: RunPiModelsSyncOptions,
  includeSupplementaryMetadata = true,
): Promise<PiModelsSyncResult> {
  const provider = options.provider?.trim();
  if (!provider) {
    throw new Error('Pass --provider <id> to select a configured Pi provider.');
  }
  const requestedIds = [...new Set((options.add ?? []).map((id) => id.trim()))];
  if (requestedIds.some((id) => !id)) {
    throw new Error('Model IDs must not be empty.');
  }
  const target = options.target ?? 'user';

  const context = await resolveConductorCommandContext(options);
  if (context.auth.backend !== 'pi' || !context.auth.pi) {
    throw new Error('Model catalog commands require the Pi conductor backend.');
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

  const { models: apiModels, metadataWarnings } = await fetchPiRemoteModels({
    provider,
    config: providerConfig,
    apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    includeSupplementaryMetadata,
    requestedModelIds: requestedIds,
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
    refreshed: [],
    ...(metadataWarnings.length > 0 ? { metadataWarnings } : {}),
  };

  if (requestedIds.length === 0) return result;

  const unknownIds = requestedIds.filter((id) => !apiIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `Cannot add model IDs that are not in the API catalog: ${unknownIds.join(', ')}.`,
    );
  }

  const targetRoot =
    target === 'project'
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
    target === 'user' &&
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
    target === 'project'
      ? [...jsonModels]
      : [...targetModels];
  for (const id of requestedIds) {
    const remoteModel = apiModels.find((model) => model.id === id)!;
    if (effectiveIds.has(id)) {
      const existingIndex = modelsForWrite.findIndex((model) => model.id === id);
      const refreshedModel =
        options.refreshMetadata && existingIndex >= 0
          ? refreshPiModelMetadata(modelsForWrite[existingIndex]!, remoteModel)
          : undefined;
      if (refreshedModel) {
        modelsForWrite[existingIndex] = refreshedModel;
        result.refreshed.push(id);
      } else {
        result.skipped.push(id);
      }
      continue;
    }
    const definition = createPiModelDefinition(remoteModel);
    modelsForWrite.push(definition);
    effectiveIds.add(id);
    result.added.push(id);
  }

  if (result.added.length > 0 || result.refreshed.length > 0) {
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
  includeSupplementaryMetadata: boolean;
  requestedModelIds: readonly string[];
}): Promise<{ models: PiRemoteModel[]; metadataWarnings: string[] }> {
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

  const models = new Map<string, PiRemoteModel>();
  const metadataWarnings: string[] = [];
  const sources = PI_MODEL_CATALOG_ENDPOINTS.filter((source) => {
    if (source.required) return true;
    return (
      options.includeSupplementaryMetadata &&
      source.providerIds?.includes(options.provider) === true
    );
  });

  for (const source of sources) {
    const fieldSources = source.fieldSources
      .filter(
        (fieldSource) =>
          fieldSource.providerIds === undefined ||
          fieldSource.providerIds.includes(options.provider),
      )
      .map((fieldSource) => fieldSource.id);
    let response: Response;
    try {
      response = await options.fetchImpl(source.buildUrl(options.config.baseUrl!), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (source.required) {
        throw new Error(
          `Could not fetch the model catalog for Pi provider "${options.provider}". Check its endpoint and network access.`,
        );
      }
      metadataWarnings.push(
        'Could not fetch LiteLLM metadata from GET /model_group/info; continuing with the available /v1/models fields only.',
      );
      continue;
    }
    if (!response.ok) {
      if (source.required) {
        throw new Error(
          `Model catalog request for Pi provider "${options.provider}" failed with HTTP ${response.status}.`,
        );
      }
      metadataWarnings.push(
        `LiteLLM GET /model_group/info returned HTTP ${response.status}; continuing with the available /v1/models fields only.`,
      );
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (source.required) {
        throw new Error(
          `Pi provider "${options.provider}" returned an invalid model catalog response.`,
        );
      }
      metadataWarnings.push(
        'LiteLLM GET /model_group/info returned invalid JSON; continuing with the available /v1/models fields only.',
      );
      continue;
    }
    const rows = source.readRows(payload);
    if (rows === undefined) {
      if (source.required) {
        throw new Error(
          `Pi provider "${options.provider}" returned an invalid model catalog response.`,
        );
      }
      metadataWarnings.push(
        'LiteLLM GET /model_group/info returned an invalid catalog shape; continuing with the available /v1/models fields only.',
      );
      continue;
    }

    if (source.formatUnmatchedRequestedModelIdsWarning) {
      const sourceModelIds = readCatalogModelIds(rows, source.modelIdField);
      const hasReasoningMetadata = rows.some(
        (value) =>
          isRecord(value) &&
          (typeof value.supports_reasoning === 'boolean' ||
            Array.isArray(value.supported_reasoning_efforts)),
      );
      const unmatchedRequestedModelIds = options.requestedModelIds.filter(
        (id) => models.has(id) && !sourceModelIds.has(id),
      );
      if (
        hasReasoningMetadata &&
        unmatchedRequestedModelIds.length > 0
      ) {
        metadataWarnings.push(
          source.formatUnmatchedRequestedModelIdsWarning(
            unmatchedRequestedModelIds,
          ),
        );
      }
    }

    mergePiModelCatalogRows(models, rows, source, fieldSources);
  }

  return {
    models: [...models.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    metadataWarnings,
  };
}

function readDataRows(payload: unknown): unknown[] | undefined {
  return isRecord(payload) && Array.isArray(payload.data)
    ? payload.data
    : undefined;
}

function readCatalogModelIds(
  rows: unknown[],
  field: string,
): Set<string> {
  const ids = new Set<string>();
  for (const value of rows) {
    if (!isRecord(value)) continue;
    const id = value[field];
    if (typeof id === 'string' && id.trim() !== '') {
      ids.add(id.trim());
    }
  }
  return ids;
}

function mergePiModelCatalogRows(
  models: Map<string, PiRemoteModel>,
  rows: unknown[],
  source: PiModelCatalogEndpointSource,
  fieldSources: readonly PiModelCatalogFieldSource[],
): void {
  for (const value of rows) {
    if (!isRecord(value)) continue;
    const rawId = value[source.modelIdField];
    if (typeof rawId !== 'string' || rawId.trim() === '') continue;
    const id = rawId.trim();
    const existing = models.get(id);
    if (source.addModelIds) {
      // Preserve the existing /v1/models rule: the first row for an ID wins.
      if (existing) continue;
      models.set(id, {
        id,
        ...readPiRemoteModelFields(value, fieldSources),
      });
      continue;
    }
    if (!existing) continue;
    const fields = readPiRemoteModelFields(value, fieldSources);
    if (Object.keys(fields).length > 0) {
      models.set(id, { ...existing, ...fields });
    }
  }
}

function readPiRemoteModelFields(
  row: PiModelCatalogRow,
  sources: readonly PiModelCatalogFieldSource[],
): Partial<Omit<PiRemoteModel, 'id'>> {
  const fields: Record<string, unknown> = {};
  for (const source of sources) {
    for (const sync of PI_MODEL_CATALOG_FIELD_SYNC) {
      const reader = sync.sources[source];
      if (!reader) continue;
      const value = reader(row);
      if (value !== undefined) {
        fields[sync.remoteField] = value;
      }
    }
  }
  return fields as Partial<Omit<PiRemoteModel, 'id'>>;
}

function readMagpieReasoning(row: PiModelCatalogRow): boolean | undefined {
  if (typeof row.reasoning === 'boolean') return row.reasoning;
  const levels = readMagpieReasoningLevels(row);
  return levels === undefined
    ? undefined
    : levels.some((level) => level !== 'off' && level !== 'none');
}

function readMagpieReasoningLevels(
  row: PiModelCatalogRow,
): string[] | undefined {
  // Magpie's OpenAI-compatible /v1/models extension publishes both forms.
  // Prefer the structured list, and accept its flat form when it is the only
  // valid representation in a row.
  if (Array.isArray(row.supported_reasoning_levels)) {
    const levels = row.supported_reasoning_levels.map((entry: unknown) =>
      isRecord(entry) && typeof entry.effort === 'string'
        ? entry.effort.trim()
        : undefined,
    );
    if (levels.every((level: string | undefined) => level !== undefined && level !== '')) {
      return levels as string[];
    }
  }

  if (Array.isArray(row.reasoning_levels)) {
    const levels = row.reasoning_levels.map((level: unknown) =>
      typeof level === 'string' ? level.trim() : undefined,
    );
    if (levels.every((level: string | undefined) => level !== undefined && level !== '')) {
      return levels as string[];
    }
  }

  return undefined;
}

function readLiteLlmReasoning(row: PiModelCatalogRow): boolean | undefined {
  // LiteLLM v1.108.3 defaults this group boolean to false and does not retain
  // whether false came from model metadata or the schema/aggregation default.
  // Only true is affirmative on its own; a listed non-off effort is also
  // affirmative evidence. Null/empty effort data cannot prove reasoning:false.
  if (row.supports_reasoning === true) return true;
  const efforts = readStringArrayField(row, 'supported_reasoning_efforts');
  return efforts?.some((effort) => effort !== 'off' && effort !== 'none')
    ? true
    : undefined;
}

function readStringArrayField(
  row: PiModelCatalogRow,
  field: string,
): string[] | undefined {
  const value = row[field];
  if (!Array.isArray(value)) return undefined;
  const strings = value.map((entry: unknown) =>
    typeof entry === 'string' ? entry.trim() : undefined,
  );
  return strings.every((entry) => entry !== undefined && entry !== '')
    ? strings as string[]
    : undefined;
}

function mapProviderThinkingLevels(
  providerLevels: string[] | undefined,
): Record<string, string | null> | undefined {
  if (providerLevels === undefined) return undefined;
  const supportedLevels = new Set(providerLevels);
  const thinkingLevelMap: Record<string, string | null> = {};
  for (const level of PI_THINKING_LEVELS) {
    const providerLevel = supportedLevels.has(level)
      ? level
      : level === 'off' && supportedLevels.has('none')
        ? 'none'
        : undefined;
    thinkingLevelMap[level] = providerLevel ?? null;
  }
  return thinkingLevelMap;
}

function createPiModelDefinition(remote: PiRemoteModel): PiModelDefinition {
  const definition: PiModelDefinition = { id: remote.id };
  for (const sync of PI_MODEL_CATALOG_FIELD_SYNC) {
    if (!sync.add) continue;
    const value = remote[sync.remoteField];
    if (value !== undefined) {
      Object.assign(definition, { [sync.piField]: value });
    }
  }
  return definition;
}

function refreshPiModelMetadata(
  existing: PiModelDefinition,
  remote: PiRemoteModel,
): PiModelDefinition | undefined {
  let changed = false;
  const refreshed: PiModelDefinition = { ...existing };

  for (const sync of PI_MODEL_CATALOG_FIELD_SYNC) {
    if (!sync.refreshExisting) continue;
    const remoteValue = remote[sync.remoteField];
    const existingValue = existing[sync.piField];
    if (remoteValue === undefined || sync.isEqual(existingValue, remoteValue)) {
      continue;
    }
    Object.assign(refreshed, { [sync.piField]: remoteValue });
    changed = true;
  }

  return changed ? refreshed : undefined;
}

function sameThinkingLevelMap(
  left: unknown,
  right: unknown,
): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    rightKeys.every((key) => left[key] === right[key])
  );
}

function buildModelsUrl(baseUrl: string): string {
  const url = parsePiProviderBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const apiPath = /\/v1$/i.test(path) ? path : `${path}/v1`;
  url.pathname = `${apiPath}/models`;
  return url.toString();
}

function buildLiteLlmModelGroupInfoUrl(baseUrl: string): string {
  const url = parsePiProviderBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  url.pathname = `${path}/model_group/info`;
  return url.toString();
}

function parsePiProviderBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Pi provider baseUrl must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Pi provider baseUrl must use HTTP or HTTPS.');
  }
  return url;
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
