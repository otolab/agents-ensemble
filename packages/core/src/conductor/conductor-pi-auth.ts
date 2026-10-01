import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuthStorage,
  ModelRegistry,
  type AuthStatus,
} from '@earendil-works/pi-coding-agent';
import {
  getEnvApiKey,
  type Model,
  type OAuthLoginCallbacks,
} from '@earendil-works/pi-ai/compat';
import {
  loadPiResources,
  resolvePiResourceRoots,
  type PiModelDefinition,
  type PiProviderConfig,
  type PiResourceLoaderOptions,
  type PiResources,
  type PiSettingsFile,
} from './pi-resource-loader.js';

/** Auth and model services for the Pi conductor's user resource layer. */
export interface PiConductorAuthContext {
  agentDir: string;
  authPath: string;
  modelsPath: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

export interface PiProviderAuthStatus {
  provider: string;
  configured: boolean;
  source?: string;
  label?: string;
}

export interface PiConductorAuthStatus {
  backend: 'pi';
  authPath: string;
  providers: PiProviderAuthStatus[];
}

export interface PiConductorLoginResult {
  backend: 'pi';
  provider: string;
  method: 'api_key' | 'oauth';
  authPath: string;
}

export interface PiConductorLogoutResult {
  backend: 'pi';
  provider: string;
  authPath: string;
}

export interface PiConductorModelListEntry {
  id: string;
  displayName: string;
  provider: string;
  description?: string;
}

export interface PiConductorAuthOptions extends PiResourceLoaderOptions {
  provider?: string;
  modelId?: string;
}

/** Create the Pi credential store and model registry for the user root. */
export function createPiConductorAuthContext(
  options: PiResourceLoaderOptions,
): PiConductorAuthContext {
  const roots = resolvePiResourceRoots(options);
  const authPath = join(roots.agentDir, 'auth.json');
  const modelsPath = join(roots.agentDir, 'models.json');
  const authStorage = AuthStorage.create(authPath);
  return {
    agentDir: roots.agentDir,
    authPath,
    modelsPath,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage, modelsPath),
  };
}

/** Resolve the provider used by `ensemble auth` from an explicit/default model. */
export async function resolvePiConductorProvider(
  options: PiConductorAuthOptions,
): Promise<string> {
  const resources = await loadPiResources(options);
  const context = createPiConductorAuthContext(options);
  return resolvePiConductorProviderFromResources(options, resources, context);
}

/** Login to a Pi provider. API-key login persists only in the user auth file. */
export async function loginPiConductor(
  options: PiConductorAuthOptions & {
    apiKey?: string;
    oauthCallbacks?: OAuthLoginCallbacks;
  },
): Promise<PiConductorLoginResult> {
  const resources = await loadPiResources(options);
  const context = createPiConductorAuthContext(options);
  const provider = resolveConductorProviderOrThrow(options, resources, context);
  const oauthProvider = context.authStorage
    .getOAuthProviders()
    .some((candidate) => candidate.id === provider);

  if (oauthProvider) {
    if (!options.oauthCallbacks) {
      throw new Error(
        `Pi provider "${provider}" uses OAuth. Run this command from a TTY so the OAuth login flow can interact with you.`,
      );
    }
    await context.authStorage.login(provider, options.oauthCallbacks);
    return {
      backend: 'pi',
      provider,
      method: 'oauth',
      authPath: context.authPath,
    };
  }

  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      `Pi provider "${provider}" requires an API key. Pass a secret API-key prompt value or set ${formatProviderEnvHint(provider)}.`,
    );
  }
  context.authStorage.set(provider, { type: 'api_key', key: apiKey });
  return {
    backend: 'pi',
    provider,
    method: 'api_key',
    authPath: context.authPath,
  };
}

/** Whether the selected Pi provider exposes Pi's native OAuth login flow. */
export async function isPiConductorOAuthProvider(
  options: PiConductorAuthOptions,
): Promise<boolean> {
  const resources = await loadPiResources(options);
  const context = createPiConductorAuthContext(options);
  const provider = resolveConductorProviderOrThrow(options, resources, context);
  return context.authStorage
    .getOAuthProviders()
    .some((candidate) => candidate.id === provider);
}

/** Remove a Pi provider's user-layer credential. */
export async function logoutPiConductor(
  options: PiConductorAuthOptions,
): Promise<PiConductorLogoutResult> {
  const resources = await loadPiResources(options);
  const context = createPiConductorAuthContext(options);
  const provider = resolveConductorProviderOrThrow(options, resources, context);
  context.authStorage.logout(provider);
  return {
    backend: 'pi',
    provider,
    authPath: context.authPath,
  };
}

/** Return non-secret Pi auth metadata for the selected/default provider. */
export async function getPiConductorAuthStatus(
  options: PiConductorAuthOptions,
): Promise<PiConductorAuthStatus> {
  const resources = await loadPiResources(options);
  const context = createPiConductorAuthContext(options);
  const providers = resolveStatusProviders(options, resources, context);
  return {
    backend: 'pi',
    authPath: context.authPath,
    providers: providers.map((provider) =>
      getPiProviderAuthStatus(provider, context, resources, options.env ?? process.env),
    ),
  };
}

/** List only Pi models whose provider has usable configured auth. */
export async function listPiConductorModels(
  options: PiConductorAuthOptions = { cwd: process.cwd() },
): Promise<PiConductorModelListEntry[]> {
  const resources = await loadPiResources(options);
  const context = createPiConductorAuthContext(options);
  const requestedProvider =
    normalizeProvider(options.provider) ?? providerFromModelId(options.modelId);
  const entries = new Map<string, PiConductorModelListEntry>();

  // ModelRegistry's fast `getAvailable()` only sees its user AuthStorage. The
  // conductor also honors project auth.json, so filter the complete registry
  // through the merged project-over-user auth view before listing models.
  for (const model of context.modelRegistry.getAll()) {
    if (requestedProvider && model.provider !== requestedProvider) continue;
    if (!hasPiProviderAuth(model.provider, context, resources, options.env ?? process.env)) {
      continue;
    }
    addPiModelEntry(entries, model);
  }

  // ModelRegistry reads the user models.json. Project models remain governed by
  // the existing resource loader, so add those merged definitions explicitly.
  for (const [provider, config] of Object.entries(resources.models.providers)) {
    if (requestedProvider && provider !== requestedProvider) continue;
    if (!hasPiProviderAuth(provider, context, resources, options.env ?? process.env)) {
      continue;
    }
    for (const model of config.models ?? []) {
      addPiCustomModelEntry(entries, provider, model);
    }
  }

  const result = [...entries.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (result.length === 0) {
    const providerHint = requestedProvider ? ` for provider "${requestedProvider}"` : '';
    throw new Error(
      `No authenticated Pi models are available${providerHint}. ` +
        `Run ensemble auth login --provider <provider>, set provider credentials in ${context.agentDir}, ` +
        'or configure a provider environment variable.',
    );
  }
  return result;
}

/** Resolve a key while retaining project-over-user auth precedence. */
export async function resolvePiConductorApiKey(options: {
  authStorage: AuthStorage;
  resources: Pick<PiResources, 'roots' | 'authLayers' | 'settings' | 'models'>;
  provider: string;
  explicitApiKey?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (options.explicitApiKey !== undefined) return options.explicitApiKey;

  // A project auth file intentionally remains above the user auth layer. When
  // both roots point at the same file, AuthStorage is the canonical reader so
  // OAuth refresh is not bypassed by the resource-layer compatibility parser.
  if (options.resources.roots.agentDir !== options.resources.roots.projectDir) {
    const projectEntry = options.resources.authLayers.at(-1)?.[options.provider];
    if (isPiOAuthAuthEntry(projectEntry)) {
      throw new Error(formatProjectOAuthAuthError(options.provider));
    }
    const projectKey = resolvePiAuthEntry(
      projectEntry,
      env,
    );
    if (projectKey !== undefined) return projectKey;
  }

  const userStatus = options.authStorage.getAuthStatus(options.provider);
  if (userStatus.source === 'stored' || userStatus.source === 'runtime') {
    // AuthStorage owns OAuth refresh and locking. Keep this call dynamic per
    // request rather than capturing its result during agent construction.
    return options.authStorage.getApiKey(options.provider);
  }

  const settingsKey = resolvePiSettingsApiKey(
    options.resources.settings,
    options.provider,
    env,
  );
  if (settingsKey !== undefined) return settingsKey;

  const modelsKey = resolvePiModelsApiKey(
    options.resources.models.providers[options.provider],
    env,
  );
  if (modelsKey !== undefined) return modelsKey;

  return getEnvApiKey(options.provider, toProviderEnv(env));
}

/** Return whether a provider has configured auth without exposing its value. */
export function hasPiProviderAuth(
  provider: string,
  context: PiConductorAuthContext,
  resources: Pick<PiResources, 'roots' | 'authLayers' | 'settings' | 'models'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const status = getPiProviderAuthStatus(provider, context, resources, env);
  return status.configured;
}

/** Synchronous readiness check used by CLI/e2e guards before async loading. */
export function hasPiConductorAuth(options: PiConductorAuthOptions): boolean {
  const context = createPiConductorAuthContext(options);
  const env = options.env ?? process.env;
  const roots = resolvePiResourceRoots(options);
  const projectAuth = readPiJsonSync(join(roots.projectDir, 'auth.json'));
  const provider =
    normalizeProvider(options.provider) ?? providerFromModelId(options.modelId);

  if (provider) {
    const projectEntry = projectAuth?.[provider];
    if (isPiOAuthAuthEntry(projectEntry)) return false;
    return (
      context.authStorage.hasAuth(provider) ||
      resolvePiAuthEntry(projectEntry, env) !== undefined ||
      resolvePiSettingsApiKey(
        (readPiJsonSync(join(roots.projectDir, 'settings.json')) as PiSettingsFile | undefined) ??
          {},
        provider,
        env,
      ) !== undefined ||
      resolvePiModelsApiKey(
        readPiJsonSync(join(roots.projectDir, 'models.json'))?.providers?.[provider] as
          | PiProviderConfig
          | undefined,
        env,
      ) !== undefined ||
      getEnvApiKey(provider, toProviderEnv(env)) !== undefined
    );
  }

  if (context.modelRegistry.getAvailable().length > 0) return true;
  if (
    Object.values(projectAuth ?? {}).some(
      (entry) => resolvePiAuthEntry(entry, env) !== undefined,
    )
  ) {
    return true;
  }
  const projectSettings =
    (readPiJsonSync(join(roots.projectDir, 'settings.json')) as PiSettingsFile | undefined) ??
    {};
  if (
    typeof projectSettings.apiKey === 'string' ||
    (isRecord(projectSettings.apiKeys) &&
      Object.values(projectSettings.apiKeys).some((entry) => typeof entry === 'string'))
  ) {
    return true;
  }
  const projectModels = readPiJsonSync(join(roots.projectDir, 'models.json'))?.providers;
  return (
    isRecord(projectModels) &&
    Object.values(projectModels).some((config) =>
      resolvePiModelsApiKey(config as PiProviderConfig, env) !== undefined,
    )
  );
}

function resolveConductorProviderOrThrow(
  options: PiConductorAuthOptions,
  resources: PiResources,
  context: PiConductorAuthContext,
): string {
  const provider = resolvePiConductorProviderFromResources(options, resources, context);
  if (provider) return provider;
  throw new Error(
    `Pi provider is not configured. Set defaultProvider in ${join(context.agentDir, 'settings.json')} or pass --provider <id>.`,
  );
}

function resolvePiConductorProviderFromResources(
  options: PiConductorAuthOptions,
  resources: PiResources,
  context: PiConductorAuthContext,
): string {
  const explicit = normalizeProvider(options.provider);
  if (explicit) return explicit;

  const requestedModel = normalizeModelId(options.modelId);
  const configuredModel = normalizeModelId(
    firstString(resources.settings.defaultModel, resources.settings.model, resources.settings.modelId),
  );
  const selectedModel = requestedModel ?? configuredModel;
  if (selectedModel?.includes('/')) {
    return selectedModel.slice(0, selectedModel.indexOf('/'));
  }

  const configuredProvider = normalizeProvider(resources.settings.defaultProvider);
  if (configuredProvider) return configuredProvider;

  if (selectedModel) {
    const matches = new Set<string>();
    for (const model of context.modelRegistry.getAll()) {
      if (model.id === selectedModel) matches.add(model.provider);
    }
    for (const [provider, config] of Object.entries(resources.models.providers)) {
      if (config.models?.some((model) => model.id === selectedModel)) {
        matches.add(provider);
      }
    }
    if (matches.size === 1) return [...matches][0]!;
  }

  return '';
}

function resolveStatusProviders(
  options: PiConductorAuthOptions,
  resources: PiResources,
  context: PiConductorAuthContext,
): string[] {
  const explicit = normalizeProvider(options.provider);
  if (explicit) return [explicit];

  const configured = resolvePiConductorProviderFromResources(options, resources, context);
  if (configured) return [configured];

  const providers = new Set<string>([
    ...context.authStorage.list(),
    ...context.modelRegistry.getAll().map((model) => model.provider),
    ...Object.keys(resources.models.providers),
    ...context.authStorage.getOAuthProviders().map((provider) => provider.id),
  ]);
  return [...providers].sort();
}

function getPiProviderAuthStatus(
  provider: string,
  context: PiConductorAuthContext,
  resources: Pick<PiResources, 'roots' | 'authLayers' | 'settings' | 'models'>,
  env: NodeJS.ProcessEnv,
): PiProviderAuthStatus {
  if (resources.roots.agentDir !== resources.roots.projectDir) {
    const projectEntry = resources.authLayers.at(-1)?.[provider];
    if (isPiOAuthAuthEntry(projectEntry)) {
      return {
        provider,
        configured: false,
        source: 'project_oauth_unsupported',
      };
    }
    const projectKey = resolvePiAuthEntry(projectEntry, env);
    if (projectKey !== undefined) {
      return { provider, configured: true, source: 'project_stored' };
    }
  }

  const registryStatus = context.modelRegistry.getProviderAuthStatus(provider);
  if (registryStatus.configured || registryStatus.source === 'stored') {
    return normalizePiAuthStatus(provider, registryStatus, true);
  }

  const settingsKey = resolvePiSettingsApiKey(resources.settings, provider, env);
  if (settingsKey !== undefined) {
    return { provider, configured: true, source: 'settings_json' };
  }

  const modelsKey = resolvePiModelsApiKey(resources.models.providers[provider], env);
  if (modelsKey !== undefined) {
    return { provider, configured: true, source: 'models_json_key' };
  }

  const envKey = getEnvApiKey(provider, toProviderEnv(env));
  if (envKey !== undefined) {
    return {
      provider,
      configured: true,
      source: 'environment',
      label: formatProviderEnvHint(provider),
    };
  }
  return normalizePiAuthStatus(provider, registryStatus, false);
}

function normalizePiAuthStatus(
  provider: string,
  status: AuthStatus,
  configured: boolean,
): PiProviderAuthStatus {
  return {
    provider,
    configured,
    ...(status.source ? { source: status.source } : {}),
    ...(status.label ? { label: status.label } : {}),
  };
}

function addPiModelEntry(
  entries: Map<string, PiConductorModelListEntry>,
  model: Model<any>,
): void {
  const id = `${model.provider}/${model.id}`;
  entries.set(id, {
    id,
    displayName: model.name || model.id,
    provider: model.provider,
  });
}

function addPiCustomModelEntry(
  entries: Map<string, PiConductorModelListEntry>,
  provider: string,
  model: PiModelDefinition,
): void {
  const id = `${provider}/${model.id}`;
  entries.set(id, {
    id,
    displayName: model.name ?? model.id,
    provider,
  });
}

function resolvePiAuthEntry(
  entry: unknown,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (typeof entry === 'string') return expandEnvReference(entry, env);
  if (!isRecord(entry)) return undefined;
  if (isPiOAuthAuthEntry(entry)) return undefined;
  for (const key of ['key', 'apiKey', 'token', 'accessToken', 'access']) {
    const value = entry[key];
    if (typeof value === 'string') return expandEnvReference(value, env);
  }
  return undefined;
}

function isPiOAuthAuthEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.type === 'oauth';
}

function formatProjectOAuthAuthError(provider: string): string {
  return (
    `Project Pi OAuth credentials for provider "${provider}" are not supported in ` +
    'project .ensemble/pi/auth.json because that layer cannot refresh them safely. ' +
    `Run ensemble auth login --provider ${provider} to store the credential in the user AuthStorage.`
  );
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

function resolvePiModelsApiKey(
  providerConfig: PiProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return providerConfig?.apiKey
    ? expandEnvReference(providerConfig.apiKey, env)
    : undefined;
}

function expandEnvReference(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (value.startsWith('!')) return undefined;
  const variable = /^\$\{([^}]+)\}$/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return variable ? env[variable[1]] : value;
}

function toProviderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function normalizeProvider(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized !== 'default' && normalized !== 'auto'
    ? normalized
    : undefined;
}

function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized !== 'default' && normalized !== 'auto'
    ? normalized
    : undefined;
}

function providerFromModelId(value: unknown): string | undefined {
  const modelId = normalizeModelId(value);
  if (!modelId?.includes('/')) return undefined;
  return normalizeProvider(modelId.slice(0, modelId.indexOf('/')));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized && normalized !== 'default' && normalized !== 'auto') return normalized;
  }
  return undefined;
}

function formatProviderEnvHint(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPiJsonSync(path: string): Record<string, any> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
