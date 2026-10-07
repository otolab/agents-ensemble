import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {
  findEnvKeys,
  getEnvApiKey,
  getModels,
  getProviders,
  type Model,
  type OAuthLoginCallbacks,
} from '@earendil-works/pi-ai/compat';
import type { AuthInteraction, AuthPrompt, AuthEvent } from '@earendil-works/pi-ai';
import {
  loadPiResources,
  resolvePiResourceRoots,
  type PiModelDefinition,
  type PiModelsFile,
  type PiProviderConfig,
  type PiResourceLoaderOptions,
  type PiResources,
  type PiSettingsFile,
} from './pi-resource-loader.js';
import { getPiHeadlessSetting } from './pi-headless-settings.js';

/** Auth and model services for the Pi conductor's user resource layer. */
export interface PiConductorAuthContext {
  agentDir: string;
  authPath: string;
  modelsPath: string;
  modelRuntime: ModelRuntime;
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

/** Create the Pi 1.x model runtime and registry for the resolved resource roots. */
export async function createPiConductorAuthContext(
  options: PiResourceLoaderOptions,
  resources?: PiResources,
): Promise<PiConductorAuthContext> {
  const roots = resolvePiResourceRoots(options);
  const authPath = join(roots.agentDir, 'auth.json');
  const modelsPath = join(roots.agentDir, 'models.json');
  const resolvedResources = resources ?? (await loadPiResources(options));
  const modelRuntime = await createPiModelRuntime(options, resolvedResources);
  return {
    agentDir: roots.agentDir,
    authPath,
    modelsPath,
    modelRuntime,
    modelRegistry: new ModelRegistry(modelRuntime),
  };
}

/** Resolve the provider used by `ensemble auth` from an explicit/default model. */
export async function resolvePiConductorProvider(
  options: PiConductorAuthOptions,
): Promise<string> {
  const resources = await loadPiResources(options);
  const context = await createPiConductorAuthContext(options, resources);
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
  const context = await createPiConductorAuthContext(options, resources);
  const provider = await resolveConductorProviderOrThrow(options, resources, context);
  const oauthProvider = Boolean(context.modelRuntime.getProvider(provider)?.auth.oauth);

  if (oauthProvider) {
    if (!options.oauthCallbacks) {
      throw new Error(
        `Pi provider "${provider}" uses OAuth. Run this command from a TTY so the OAuth login flow can interact with you.`,
      );
    }
    await context.modelRuntime.login(
      provider,
      'oauth',
      toPiAuthInteraction(options.oauthCallbacks),
    );
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
      `Pi provider "${provider}" requires an API key. Pass a secret API-key prompt value or set ${formatPiProviderEnvHint(provider)}.`,
    );
  }
  await writePiApiKey(context.authPath, provider, apiKey);
  await context.modelRuntime.setRuntimeApiKey(provider, apiKey);
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
  const context = await createPiConductorAuthContext(options, resources);
  const provider = await resolveConductorProviderOrThrow(options, resources, context);
  return Boolean(context.modelRuntime.getProvider(provider)?.auth.oauth);
}

/** Remove a Pi provider's user-layer credential. */
export async function logoutPiConductor(
  options: PiConductorAuthOptions,
): Promise<PiConductorLogoutResult> {
  const resources = await loadPiResources(options);
  const context = await createPiConductorAuthContext(options, resources);
  const provider = await resolveConductorProviderOrThrow(options, resources, context);
  await context.modelRuntime.logout(provider);
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
  const context = await createPiConductorAuthContext(options, resources);
  const providers = await resolveStatusProviders(options, resources, context);
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
  const context = await createPiConductorAuthContext(options, resources);
  const requestedProvider =
    normalizeProvider(options.provider) ?? providerFromModelId(options.modelId);
  const entries = new Map<string, PiConductorModelListEntry>();

  // Filter the complete Pi 1.x runtime catalog through the merged
  // project-over-user auth view before listing models.
  for (const model of context.modelRegistry.getAll()) {
    if (requestedProvider && model.provider !== requestedProvider) continue;
    if (!hasPiProviderAuth(model.provider, context, resources, options.env ?? process.env)) {
      continue;
    }
    addPiModelEntry(entries, model);
  }

  // The runtime is built from the merged models resource, so custom models are
  // already included in the registry above.

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
  modelRuntime: ModelRuntime;
  resources: Pick<PiResources, 'roots' | 'authLayers' | 'settings' | 'models'>;
  provider: string;
  explicitApiKey?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (options.explicitApiKey !== undefined) return options.explicitApiKey;

  // A project auth file intentionally remains above the user auth layer. When
  // both roots point at the same file, ModelRuntime is the canonical reader so
  // OAuth refresh is not bypassed by the resource-layer compatibility parser.
  const projectEntry = options.resources.authLayers.at(-1)?.[options.provider];
  const projectKey =
    options.resources.roots.agentDir !== options.resources.roots.projectDir
      ? resolvePiAuthEntry(projectEntry, env)
      : undefined;
  const settingsKey = resolvePiSettingsApiKey(
    options.resources.settings,
    options.provider,
    env,
  );
  const modelsKey = resolvePiModelsApiKey(
    options.resources.models.providers[options.provider],
    env,
  );

  if (options.resources.roots.agentDir !== options.resources.roots.projectDir) {
    if (isPiOAuthAuthEntry(projectEntry)) {
      throw new Error(formatProjectOAuthAuthError(options.provider));
    }
    if (projectKey !== undefined && !isPiCommandConfigValue(projectKey)) {
      return projectKey;
    }
    if (projectKey !== undefined) {
      // A project auth entry intentionally outranks the user credential. Use
      // the Pi resolver through an isolated provider id so ModelRuntime does
      // not select the lower-precedence user auth.json entry first.
      return resolvePiProjectCommandApiKey(
        options.modelRuntime,
        options.provider,
        projectKey,
      );
    }
  }

  // Pi resolves command references from the provider configuration at request
  // time. Settings/auth are loaded by ensemble rather than Pi's resource
  // loader, so register command references through the same public runtime API
  // before asking the runtime for the request credential. Project auth keeps
  // its higher precedence over settings and models.
  if (settingsKey !== undefined && isPiCommandConfigValue(settingsKey)) {
    options.modelRuntime.registerProvider(options.provider, { apiKey: settingsKey });
  }
  // ModelRuntime owns the Pi 1.x credential store, OAuth refresh, and locking.
  // Resolve it on every request instead of capturing the key at construction.
  let runtimeError: unknown;
  try {
    const runtimeAuth = await options.modelRuntime.getAuth(options.provider);
    if (runtimeAuth?.auth.apiKey !== undefined) return runtimeAuth.auth.apiKey;
  } catch (error) {
    runtimeError = error;
    // Non-command references can still use the ensemble fallback chain. A
    // command reference is reported below instead of returning the raw command
    // as an API key.
  }

  const commandKey = [settingsKey, modelsKey].find(
    (value): value is string => value !== undefined && isPiCommandConfigValue(value),
  );
  if (commandKey !== undefined) {
    throw formatPiCommandResolutionError(options.provider, commandKey, runtimeError);
  }

  if (settingsKey !== undefined) return settingsKey;

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
  const env = options.env ?? process.env;
  const roots = resolvePiResourceRoots(options);
  const userAuth = readPiJsonSync(join(roots.agentDir, 'auth.json'));
  const projectAuth = readPiJsonSync(join(roots.projectDir, 'auth.json'));
  const settings = readPiSettingsSync(roots);
  const models = readPiModelsSync(roots);
  const selection = resolvePiConductorSelectionSync(options, settings, models, userAuth);

  if (selection.provider) {
    return hasPiProviderAuthSync({
      provider: selection.provider,
      roots,
      userAuth,
      projectAuth,
      settings,
      models,
      env,
    });
  }

  // A configured model that cannot be mapped to one provider is not a
  // usable conductor selection, even if another provider happens to have
  // credentials.
  if (selection.modelId) return false;

  return hasAnyPiConductorAuthSync({
    roots,
    userAuth,
    projectAuth,
    settings,
    models,
    env,
  });
}

interface PiConductorSelection {
  provider?: string;
  modelId?: string;
}

interface PiConductorAuthSyncContext {
  roots: ReturnType<typeof resolvePiResourceRoots>;
  userAuth: Record<string, any> | undefined;
  projectAuth: Record<string, any> | undefined;
  settings: PiSettingsFile;
  models: PiModelsFile;
  env: NodeJS.ProcessEnv;
}

/**
 * Mirror PiConductorAgent's synchronous provider/model selection for guards.
 * The async agent receives the same merged settings and model layers.
 */
function resolvePiConductorSelectionSync(
  options: PiConductorAuthOptions,
  settings: PiSettingsFile,
  models: PiModelsFile,
  userAuth: Record<string, any> | undefined,
): PiConductorSelection {
  const requestedModel = normalizeModelId(options.modelId);
  const configuredModel = normalizeModelId(
    firstString(
      getPiHeadlessSetting(settings, 'defaultModel', 'model-selection'),
      getPiHeadlessSetting(settings, 'model', 'model-selection'),
      getPiHeadlessSetting(settings, 'modelId', 'model-selection'),
    ),
  );
  const selectedModel = requestedModel ?? configuredModel;
  let provider = normalizeProvider(options.provider);
  let modelId = selectedModel;

  if (selectedModel?.includes('/')) {
    const separator = selectedModel.indexOf('/');
    if (!provider) {
      provider = normalizeProvider(selectedModel.slice(0, separator));
    }
    modelId = normalizeModelId(selectedModel.slice(separator + 1));
  }

  if (!provider) {
    provider = normalizeProvider(
      getPiHeadlessSetting(settings, 'defaultProvider', 'model-selection'),
    );
  }

  if (!provider && modelId) {
    const matches = new Set<string>();
    for (const model of knownPiModelsSync(models, userAuth)) {
      if (model.id === modelId) matches.add(model.provider);
    }
    for (const [candidate, config] of Object.entries(models.providers)) {
      if (config.models?.some((model) => model.id === modelId)) {
        matches.add(candidate);
      }
    }
    if (matches.size === 1) provider = [...matches][0];
  }

  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function hasPiProviderAuthSync(
  options: PiConductorAuthSyncContext & { provider: string },
): boolean {
  const projectEntry = options.projectAuth?.[options.provider];
  if (
    options.roots.agentDir !== options.roots.projectDir &&
    isPiOAuthAuthEntry(projectEntry)
  ) {
    return false;
  }
  if (resolvePiAuthEntry(projectEntry, options.env) !== undefined) return true;
  if (resolvePiAuthEntry(options.userAuth?.[options.provider], options.env) !== undefined) {
    return true;
  }
  if (
    resolvePiSettingsApiKey(options.settings, options.provider, options.env) !== undefined
  ) {
    return true;
  }
  if (
    resolvePiModelsApiKey(
      options.models.providers[options.provider],
      options.env,
    ) !== undefined
  ) {
    return true;
  }
  return getEnvApiKey(options.provider, toProviderEnv(options.env)) !== undefined;
}

function hasAnyPiConductorAuthSync(options: PiConductorAuthSyncContext): boolean {
  const providers = new Set<string>([
    ...Object.keys(options.userAuth ?? {}),
    ...knownPiModelsSync(options.models, options.userAuth).map((model) => model.provider),
    ...Object.keys(options.models.providers),
    ...Object.keys(options.projectAuth ?? {}),
    ...getProviders(),
  ]);
  for (const provider of providers) {
    if (hasPiProviderAuthSync({ ...options, provider })) return true;
  }

  if (
    typeof getPiHeadlessSetting(options.settings, 'apiKey', 'auth-fallback') === 'string' ||
    (isRecord(getPiHeadlessSetting(options.settings, 'apiKeys', 'auth-fallback')) &&
      Object.values(
        getPiHeadlessSetting(
          options.settings,
          'apiKeys',
          'auth-fallback',
        ) as Record<string, unknown>,
      ).some((entry) => typeof entry === 'string'))
  ) {
    return true;
  }
  return false;
}

function readPiSettingsSync(
  roots: ReturnType<typeof resolvePiResourceRoots>,
): PiSettingsFile {
  return mergePiRecords(
    readPiJsonSync(join(roots.agentDir, 'settings.json')) ?? {},
    readPiJsonSync(join(roots.projectDir, 'settings.json')) ?? {},
  ) as PiSettingsFile;
}

function readPiModelsSync(
  roots: ReturnType<typeof resolvePiResourceRoots>,
): PiModelsFile {
  const merged = mergePiRecords(
    readPiJsonSync(join(roots.agentDir, 'models.json')) ?? {},
    readPiJsonSync(join(roots.projectDir, 'models.json')) ?? {},
  );
  return {
    providers: isRecord(merged.providers)
      ? (merged.providers as Record<string, PiProviderConfig>)
      : {},
  };
}

async function resolveConductorProviderOrThrow(
  options: PiConductorAuthOptions,
  resources: PiResources,
  context: PiConductorAuthContext,
): Promise<string> {
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
    firstString(
      getPiHeadlessSetting(resources.settings, 'defaultModel', 'model-selection'),
      getPiHeadlessSetting(resources.settings, 'model', 'model-selection'),
      getPiHeadlessSetting(resources.settings, 'modelId', 'model-selection'),
    ),
  );
  const selectedModel = requestedModel ?? configuredModel;
  if (selectedModel?.includes('/')) {
    return selectedModel.slice(0, selectedModel.indexOf('/'));
  }

  const configuredProvider = normalizeProvider(
    getPiHeadlessSetting(resources.settings, 'defaultProvider', 'model-selection'),
  );
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

async function resolveStatusProviders(
  options: PiConductorAuthOptions,
  resources: PiResources,
  context: PiConductorAuthContext,
): Promise<string[]> {
  const explicit = normalizeProvider(options.provider);
  if (explicit) return [explicit];

  const configured = resolvePiConductorProviderFromResources(options, resources, context);
  if (configured) return [configured];

  const providers = new Set<string>([
    ...(await context.modelRuntime.listCredentials()).map((entry) => entry.providerId),
    ...context.modelRegistry.getAll().map((model) => model.provider),
    ...Object.keys(resources.models.providers),
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

  const registryStatus = context.modelRuntime.getProviderAuthStatus(provider);
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
      label: formatPiProviderEnvHint(provider),
    };
  }
  return normalizePiAuthStatus(provider, registryStatus, false);
}

function normalizePiAuthStatus(
  provider: string,
  status: PiRuntimeAuthStatus,
  configured: boolean,
): PiProviderAuthStatus {
  return {
    provider,
    configured,
    ...(status.source ? { source: status.source } : {}),
    ...(status.label ? { label: status.label } : {}),
  };
}

type PiRuntimeAuthStatus = {
  configured: boolean;
  source?: string;
  label?: string;
};

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
    `Run ensemble auth login --provider ${provider} to store the credential in the user Pi runtime.`
  );
}

function resolvePiSettingsApiKey(
  settings: PiSettingsFile,
  provider: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const apiKey = getPiHeadlessSetting(settings, 'apiKey', 'auth-fallback');
  if (typeof apiKey === 'string') {
    return expandEnvReference(apiKey, env);
  }
  const apiKeys = getPiHeadlessSetting(settings, 'apiKeys', 'auth-fallback');
  if (!isRecord(apiKeys)) return undefined;
  const value = apiKeys[provider];
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
  // Keep Pi command references opaque here. ModelRuntime's public provider
  // registration path resolves `!command` with Pi's resolver at request time.
  const variable = /^\$\{([^}]+)\}$/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return variable ? env[variable[1]] : value;
}

function isPiCommandConfigValue(value: string): boolean {
  return value.startsWith('!');
}

function formatPiCommandResolutionError(
  provider: string,
  command: string,
  cause: unknown,
): Error {
  const causeMessage = cause instanceof Error ? ` (${cause.message})` : '';
  return new Error(
    `Failed to resolve API key for Pi provider "${provider}" from shell command: ${command.slice(1)}${causeMessage}`,
    cause instanceof Error ? { cause } : undefined,
  );
}

async function resolvePiProjectCommandApiKey(
  modelRuntime: ModelRuntime,
  provider: string,
  command: string,
): Promise<string> {
  const isolatedProvider = `__agents_ensemble_project_auth__${provider}`;
  modelRuntime.registerProvider(isolatedProvider, { apiKey: command });
  try {
    const runtimeAuth = await modelRuntime.getAuth(isolatedProvider);
    if (runtimeAuth?.auth.apiKey !== undefined) {
      // Keep the resolved project credential as an in-memory runtime override
      // so the actual conductor request also uses project-over-user auth.
      await modelRuntime.setRuntimeApiKey(provider, runtimeAuth.auth.apiKey);
      return runtimeAuth.auth.apiKey;
    }
  } catch (error) {
    throw formatPiCommandResolutionError(provider, command, error);
  }
  throw formatPiCommandResolutionError(provider, command, undefined);
}

function toProviderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** Build the Pi 1.x runtime from the already-resolved ensemble resource view. */
async function createPiModelRuntime(
  options: PiResourceLoaderOptions,
  resources: PiResources,
): Promise<ModelRuntime> {
  const roots = resolvePiResourceRoots(options);
  const runtime = await ModelRuntime.create({
    authPath: join(roots.agentDir, 'auth.json'),
    // The ensemble resource loader has already merged user and project models.
    // Avoid letting ModelRuntime read an unmerged second view of models.json.
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const env = options.env ?? process.env;
  for (const [provider, config] of Object.entries(resources.models.providers)) {
    runtime.registerProvider(provider, toPiRuntimeProviderConfig(config, env));
  }

  if (roots.agentDir !== roots.projectDir) {
    for (const [provider, entry] of Object.entries(resources.authLayers.at(-1) ?? {})) {
      if (isPiOAuthAuthEntry(entry)) continue;
      const key = resolvePiAuthEntry(entry, env);
      if (key !== undefined && !isPiCommandConfigValue(key)) {
        await runtime.setRuntimeApiKey(provider, key);
      }
    }
  }

  const apiKeys = getPiHeadlessSetting(resources.settings, 'apiKeys', 'auth-fallback');
  if (isRecord(apiKeys)) {
    for (const [provider, value] of Object.entries(apiKeys)) {
      if (typeof value !== 'string') continue;
      const key = expandEnvReference(value, env);
      if (key !== undefined && !isPiCommandConfigValue(key)) {
        await runtime.setRuntimeApiKey(provider, key);
      }
    }
  }

  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

function toPiRuntimeProviderConfig(
  config: PiProviderConfig,
  env: NodeJS.ProcessEnv,
): Parameters<ModelRuntime['registerProvider']>[1] {
  const models = config.models?.map((model) => ({
    type: 'chat' as const,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.api ?? config.api ? { api: model.api ?? config.api } : {}),
    ...(model.baseUrl ?? config.baseUrl
      ? { baseUrl: model.baseUrl ?? config.baseUrl }
      : {}),
    input: model.input ?? ['text'],
    reasoning: model.reasoning ?? false,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    cost: model.cost ?? emptyPiModelCost(),
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxTokens ?? 16384,
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  }));

  return {
    ...(config.name ? { name: config.name } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey
      ? { apiKey: expandEnvReference(config.apiKey, env) ?? undefined }
      : {}),
    ...(config.api ? { api: config.api as any } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.authHeader !== undefined ? { authHeader: config.authHeader } : {}),
    ...(models ? { models } : {}),
  } as Parameters<ModelRuntime['registerProvider']>[1];
}

async function writePiApiKey(
  authPath: string,
  provider: string,
  apiKey: string,
): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true });
  let auth: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath, 'utf8'));
    if (isRecord(parsed)) auth = parsed;
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
  auth[provider] = { type: 'api_key', key: apiKey };
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
}

function toPiAuthInteraction(callbacks: OAuthLoginCallbacks): AuthInteraction {
  return {
    signal: callbacks.signal,
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type === 'select') {
        const selected = await callbacks.onSelect({
          message: prompt.message,
          options: prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
          })),
        });
        if (selected === undefined) throw new Error('OAuth login was cancelled.');
        return selected;
      }
      if (prompt.type === 'manual_code' && callbacks.onManualCodeInput) {
        return callbacks.onManualCodeInput();
      }
      return callbacks.onPrompt({
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      });
    },
    notify: (event: AuthEvent) => {
      if (event.type === 'auth_url') {
        callbacks.onAuth({ url: event.url, instructions: event.instructions });
      } else if (event.type === 'device_code') {
        callbacks.onDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...(event.intervalSeconds !== undefined
            ? { intervalSeconds: event.intervalSeconds }
            : {}),
          ...(event.expiresInSeconds !== undefined
            ? { expiresInSeconds: event.expiresInSeconds }
            : {}),
        });
      } else if (callbacks.onProgress) {
        callbacks.onProgress(event.message);
      }
    },
  };
}

function knownPiModelsSync(
  models: PiModelsFile,
  _userAuth?: Record<string, any>,
): Array<Pick<Model<any>, 'id' | 'provider'> & Partial<Pick<Model<any>, 'name'>>> {
  const result: Array<Pick<Model<any>, 'id' | 'provider'> & Partial<Pick<Model<any>, 'name'>>> = [];
  for (const provider of getProviders()) {
    try {
      for (const model of getModels(provider as never) ?? []) result.push(model);
    } catch {
      // A static provider catalog failure must not make the sync auth guard fail.
    }
  }
  for (const [provider, config] of Object.entries(models.providers)) {
    for (const model of config.models ?? []) {
      result.push({ provider, id: model.id, name: model.name });
    }
  }
  return result;
}

function emptyPiModelCost(): NonNullable<PiModelDefinition['cost']> {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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

/** Return the concrete environment variables recognised by Pi for a provider. */
export function formatPiProviderEnvHint(provider: string): string {
  // `findEnvKeys` normally reports only variables that are currently set. A
  // truthy probe lets the SDK expose its existing provider mapping even for a
  // missing credential, which is the case where this recovery hint is used.
  const envKeys = findEnvKeys(provider, PI_ENV_HINT_PROBE);
  if (envKeys) return envKeys.join(' / ');

  if (provider === 'google-vertex') {
    return 'GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION';
  }
  if (provider === 'amazon-bedrock') {
    return (
      'AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY / ' +
      'AWS_BEARER_TOKEN_BEDROCK'
    );
  }

  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

const PI_ENV_HINT_PROBE = new Proxy<Record<string, string>>(
  {},
  { get: (_target, property) => (typeof property === 'string' ? 'configured' : undefined) },
);

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

function mergePiRecords(
  base: Record<string, any>,
  override: Record<string, any>,
): Record<string, any> {
  const merged: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key];
    merged[key] =
      isRecord(previous) && isRecord(value)
        ? mergePiRecords(previous, value)
        : value;
  }
  return merged;
}
