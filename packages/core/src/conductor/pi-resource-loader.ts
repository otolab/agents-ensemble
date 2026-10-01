import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';

/** The Pi settings fields used by model/auth resolution and resource loading. */
export interface PiSettingsFile {
  [key: string]: unknown;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  model?: unknown;
  modelId?: unknown;
  apiKey?: unknown;
  apiKeys?: unknown;
  extensions?: unknown;
  skills?: unknown;
  prompts?: unknown;
  themes?: unknown;
}

export type PiAuthFile = Record<string, unknown>;

export interface PiResourceRoots {
  agentDir: string;
  projectDir: string;
}

export interface PiResourceLoaderOptions {
  cwd: string;
  pi?: {
    agentDir?: string;
    projectDir?: string;
  };
  /** Injectable environment/home for tests; production uses process defaults. */
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface PiResources {
  roots: PiResourceRoots;
  settings: PiSettingsFile;
  auth: PiAuthFile;
  extensionTools: AgentTool[];
  extensionPaths: string[];
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
}

const EXTENSION_FILE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts']);
const RESOURCE_FILE_EXTENSIONS = new Set([
  '.css',
  '.json',
  '.md',
  '.mjs',
  '.js',
  '.ts',
]);

/**
 * Resolve the two Pi resource roots used by the conductor.
 *
 * `agentDir` is the user root and defaults to `~/.ensemble/pi`; `projectDir`
 * is the repository root and defaults to `<cwd>/.ensemble/pi`. The optional
 * environment variable is retained for compatibility with Pi's launcher.
 */
export function resolvePiResourceRoots(
  options: PiResourceLoaderOptions,
): PiResourceRoots {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return {
    agentDir: resolveRootPath(
      options.pi?.agentDir ?? env.PI_CODING_AGENT_DIR,
      options.cwd,
      home,
      join(home, '.ensemble', 'pi'),
    ),
    projectDir: resolveRootPath(
      options.pi?.projectDir,
      options.cwd,
      home,
      join(options.cwd, '.ensemble', 'pi'),
    ),
  };
}

function resolveRootPath(
  configured: string | undefined,
  cwd: string,
  home: string,
  fallback: string,
): string {
  if (!configured) return fallback;
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return join(home, configured.slice(2));
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

/**
 * Load Pi's standard file resources for a conductor.
 *
 * User resources are read first and project resources second. Settings/auth
 * objects are deep-merged, project extension tools replace same-named user
 * tools, and extension loading failures are isolated so a broken optional
 * local extension cannot prevent the fixed harness tools from starting.
 *
 * The conductor intentionally depends on low-level `pi-agent-core` rather
 * than the interactive `pi-coding-agent` package. This loader mirrors the
 * coding-agent resource roots and extension registration boundary without
 * adding Pi's built-in coding tools to the conductor.
 */
export async function loadPiResources(
  options: PiResourceLoaderOptions,
): Promise<PiResources> {
  const roots = resolvePiResourceRoots(options);
  const layers = [
    await readResourceLayer(roots.agentDir),
    await readResourceLayer(roots.projectDir),
  ];

  let settings: PiSettingsFile = {};
  let auth: PiAuthFile = {};
  for (const layer of layers) {
    settings = mergeRecords(settings, layer.settings) as PiSettingsFile;
    auth = mergeRecords(auth, layer.auth);
  }

  const extensionPaths = uniquePaths([
    ...layers.flatMap((layer) => layer.extensionPaths),
  ]);
  const skillPaths = uniquePaths([
    ...layers.flatMap((layer) => layer.skillPaths),
  ]);
  const promptPaths = uniquePaths([
    ...layers.flatMap((layer) => layer.promptPaths),
  ]);
  const themePaths = uniquePaths([
    ...layers.flatMap((layer) => layer.themePaths),
  ]);

  return {
    roots,
    settings,
    auth,
    extensionTools: await loadExtensionTools(extensionPaths, options.cwd),
    extensionPaths,
    skillPaths,
    promptPaths,
    themePaths,
  };
}

interface ResourceLayer {
  settings: PiSettingsFile;
  auth: PiAuthFile;
  extensionPaths: string[];
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
}

async function readResourceLayer(root: string): Promise<ResourceLayer> {
  const settings = (await readOptionalJson(join(root, 'settings.json'))) as PiSettingsFile ?? {};
  return {
    settings,
    auth: (await readOptionalJson(join(root, 'auth.json'))) ?? {},
    extensionPaths: uniquePaths([
      ...(await discoverDirectoryResources(join(root, 'extensions'), true)),
      ...configuredResourcePaths(settings.extensions, root),
    ]),
    skillPaths: uniquePaths([
      ...(await discoverDirectoryResources(join(root, 'skills'), false)),
      ...configuredResourcePaths(settings.skills, root),
    ]),
    promptPaths: uniquePaths([
      ...(await discoverDirectoryResources(join(root, 'prompts'), false)),
      ...configuredResourcePaths(settings.prompts, root),
    ]),
    themePaths: uniquePaths([
      ...(await discoverDirectoryResources(join(root, 'themes'), false)),
      ...configuredResourcePaths(settings.themes, root),
    ]),
  };
}

async function discoverDirectoryResources(
  directory: string,
  extensionsOnly: boolean,
): Promise<string[]> {
  const entries = await readDirectory(directory);
  const resources: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (extensionsOnly) {
        const declared = await readPackageExtensionEntries(path);
        if (declared.length > 0) {
          resources.push(...declared);
        } else {
          const index = await firstExistingPath([
            join(path, 'index.ts'),
            join(path, 'index.js'),
          ]);
          if (index) resources.push(index);
        }
      } else {
        resources.push(path);
      }
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (
      extension &&
      (extensionsOnly
        ? EXTENSION_FILE_EXTENSIONS.has(extension)
        : RESOURCE_FILE_EXTENSIONS.has(extension))
    ) {
      resources.push(path);
    }
  }
  return resources.sort();
}

async function readPackageExtensionEntries(directory: string): Promise<string[]> {
  const packageJson = await readOptionalJson(join(directory, 'package.json'));
  const pi = packageJson?.pi;
  if (!isRecord(pi) || !Array.isArray(pi.extensions)) return [];
  return pi.extensions.flatMap((value) => {
    if (typeof value !== 'string' || value.trim() === '') return [];
    return [resolve(directory, value.trim())];
  });
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await readFile(path);
      return path;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
  }
  return undefined;
}

async function readDirectory(
  directory: string,
): Promise<Array<{ name: string; isDirectory(): boolean }>> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isPathUnavailable(error)) return [];
    throw error;
  }
}

async function readOptionalJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
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

function configuredResourcePaths(
  configured: unknown,
  root: string,
): string[] {
  const values = Array.isArray(configured) ? configured : [configured];
  return values.flatMap((value) => {
    if (typeof value !== 'string' || value.trim() === '') return [];
    const path = value.trim();
    return [
      isAbsolute(path)
        ? path
        : resolve(root, path),
    ];
  });
}

async function loadExtensionTools(
  extensionPaths: string[],
  cwd: string,
): Promise<AgentTool[]> {
  const tools = new Map<string, AgentTool>();
  for (const extensionPath of extensionPaths) {
    const discovered = await discoverDirectoryResources(extensionPath, true);
    const candidates = discovered.length > 0 ? discovered : [extensionPath];
    for (const candidate of candidates) {
      if (!EXTENSION_FILE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
        continue;
      }
      try {
        const extensionTools = await loadExtension(candidate, cwd);
        for (const tool of extensionTools) {
          tools.set(tool.name, tool);
        }
      } catch {
        // Extension resources are optional. The fixed harness/MCP loadout must
        // remain available even when a local extension has a missing dependency.
      }
    }
  }
  return [...tools.values()];
}

interface ExtensionToolDefinition {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (...args: unknown[]) => void,
    context?: unknown,
  ) => Promise<unknown>;
}

async function loadExtension(
  extensionPath: string,
  cwd: string,
): Promise<AgentTool[]> {
  const module = (await import(
    `${pathToFileURL(extensionPath).href}?ensemble=${encodeURIComponent(String(Date.now()))}`
  )) as { default?: unknown };
  const factory = module.default;
  if (typeof factory !== 'function') return [];

  const registered: ExtensionToolDefinition[] = [];
  const extensionFactory = factory as (
    api: Record<string, unknown>,
  ) => void | Promise<void>;
  await extensionFactory({
    registerTool: (definition: unknown) => {
      if (isRecord(definition) && typeof definition.name === 'string' && typeof definition.execute === 'function') {
        registered.push(definition as unknown as ExtensionToolDefinition);
      }
    },
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    registerProvider: () => {},
    cwd,
  });

  return registered.map((definition) => toPiAgentTool(definition, cwd));
}

function toPiAgentTool(
  definition: ExtensionToolDefinition,
  cwd: string,
): AgentTool {
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description ?? '',
    parameters: definition.parameters as AgentTool['parameters'],
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await definition.execute(
        toolCallId,
        params as Record<string, unknown>,
        signal,
        onUpdate as unknown as (...args: unknown[]) => void,
        createExtensionContext(cwd, signal),
      );
      return normalizeToolResult(result);
    },
  };
}

function createExtensionContext(
  cwd: string,
  signal: AbortSignal | undefined,
): Record<string, unknown> {
  return {
    cwd,
    signal,
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      confirm: async () => false,
      select: async () => undefined,
      input: async () => undefined,
    },
  };
}

function normalizeToolResult(result: unknown): Awaited<ReturnType<AgentTool['execute']>> {
  if (isRecord(result) && Array.isArray(result.content)) {
    return {
      ...result,
      details: result.details ?? {},
    } as Awaited<ReturnType<AgentTool['execute']>>;
  }
  return {
    content: [{ type: 'text', text: String(result ?? '') }],
    details: {},
  } as Awaited<ReturnType<AgentTool['execute']>>;
}

function mergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key];
    merged[key] =
      isRecord(previous) && isRecord(value)
        ? mergeRecords(previous, value)
        : value;
  }
  return merged;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isPathUnavailable(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
