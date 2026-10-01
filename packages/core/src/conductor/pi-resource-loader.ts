import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
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

export interface PiModelsFile {
  providers: Record<string, PiProviderConfig>;
}

export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: PiModelDefinition[];
  modelOverrides?: Record<string, PiModelOverride>;
}

export interface PiModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<'text' | 'image'>;
  cost?: PiModelCost;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface PiModelOverride {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<'text' | 'image'>;
  cost?: Partial<PiModelCost>;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<PiModelCostTier>;
}

export interface PiModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiSkillResource {
  name: string;
  description: string;
  filePath: string;
  content: string;
  disableModelInvocation: boolean;
}

export interface PiPromptResource {
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
  content: string;
}

export interface PiThemeResource {
  name: string;
  filePath: string;
  value: Record<string, unknown>;
}

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
  /** Unmerged layers, in user → project order, for provider-level precedence. */
  authLayers: PiAuthFile[];
  models: PiModelsFile;
  extensionTools: AgentTool[];
  extensionPaths: string[];
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
  skills: PiSkillResource[];
  prompts: PiPromptResource[];
  themes: PiThemeResource[];
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
    authLayers: layers.map((layer) => layer.auth),
    models: mergeModels(layers.map((layer) => layer.models)),
    extensionTools: await loadExtensionTools(extensionPaths, options.cwd),
    extensionPaths,
    skillPaths,
    promptPaths,
    themePaths,
    skills: await loadSkills(skillPaths),
    prompts: await loadPromptTemplates(promptPaths),
    themes: await loadThemes(themePaths),
  };
}

interface ResourceLayer {
  settings: PiSettingsFile;
  auth: PiAuthFile;
  models: PiModelsFile;
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
    models: normalizeModelsFile(
      (await readOptionalJson(join(root, 'models.json'))) ?? {},
      join(root, 'models.json'),
    ),
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
    const value: unknown = JSON.parse(stripJsonComments(source));
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

function normalizeModelsFile(
  value: Record<string, unknown>,
  path: string,
): PiModelsFile {
  const providers = value.providers;
  if (providers === undefined) return { providers: {} };
  if (!isRecord(providers)) {
    throw new Error(`Expected a providers object in Pi models file ${path}.`);
  }

  for (const [provider, config] of Object.entries(providers)) {
    if (!isRecord(config)) {
      throw new Error(`Expected provider "${provider}" to be an object in Pi models file ${path}.`);
    }
    for (const key of ['baseUrl', 'apiKey', 'api']) {
      if (config[key] !== undefined && typeof config[key] !== 'string') {
        throw new Error(`Expected provider "${provider}" ${key} to be a string in Pi models file ${path}.`);
      }
    }
    if (config.authHeader !== undefined && typeof config.authHeader !== 'boolean') {
      throw new Error(`Expected provider "${provider}" authHeader to be a boolean in Pi models file ${path}.`);
    }
    if (config.models !== undefined && !Array.isArray(config.models)) {
      throw new Error(`Expected provider "${provider}" models to be an array in Pi models file ${path}.`);
    }
    for (const model of config.models ?? []) {
      if (!isRecord(model) || typeof model.id !== 'string' || model.id.trim() === '') {
        throw new Error(`Expected provider "${provider}" models to contain an id in Pi models file ${path}.`);
      }
    }
    if (config.modelOverrides !== undefined && !isRecord(config.modelOverrides)) {
      throw new Error(
        `Expected provider "${provider}" modelOverrides to be an object in Pi models file ${path}.`,
      );
    }
    for (const [modelId, override] of Object.entries(config.modelOverrides ?? {})) {
      if (!isRecord(override)) {
        throw new Error(
          `Expected provider "${provider}" model override "${modelId}" to be an object in Pi models file ${path}.`,
        );
      }
    }
  }

  return { providers: providers as Record<string, PiProviderConfig> };
}

function mergeModels(layers: PiModelsFile[]): PiModelsFile {
  let merged: Record<string, unknown> = { providers: {} };
  for (const layer of layers) {
    merged = mergeRecords(merged, layer as unknown as Record<string, unknown>);
  }
  return normalizeModelsFile(merged, 'merged Pi models');
}

async function loadSkills(paths: string[]): Promise<PiSkillResource[]> {
  const skills = new Map<string, PiSkillResource>();
  for (const path of paths) {
    for (const filePath of await discoverSkillFiles(path)) {
      const resource = await readSkill(filePath);
      if (resource) skills.set(resource.name, resource);
    }
  }
  return [...skills.values()];
}

async function discoverSkillFiles(path: string): Promise<string[]> {
  const directFile = await readableFile(path);
  if (directFile && extname(path).toLowerCase() === '.md') return [path];

  const entries = await readDirectory(path);
  if (entries.length === 0) return [];
  const skillFile = join(path, 'SKILL.md');
  if (await readableFile(skillFile)) return [skillFile];

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverSkillFiles(child)));
    } else if (extname(entry.name).toLowerCase() === '.md') {
      files.push(child);
    }
  }
  return files;
}

async function readSkill(path: string): Promise<PiSkillResource | undefined> {
  const source = await readOptionalText(path);
  if (source === undefined) return undefined;
  const parsed = parseMarkdownResource(source);
  const name = stringValue(parsed.frontmatter.name) ?? basename(dirname(path));
  const description =
    stringValue(parsed.frontmatter.description) ?? firstNonEmptyLine(parsed.body) ?? name;
  return {
    name,
    description,
    filePath: path,
    content: parsed.body,
    disableModelInvocation: parsed.frontmatter['disable-model-invocation'] === true,
  };
}

async function loadPromptTemplates(paths: string[]): Promise<PiPromptResource[]> {
  const prompts = new Map<string, PiPromptResource>();
  for (const filePath of await discoverFiles(paths, '.md', false)) {
    const source = await readOptionalText(filePath);
    if (source === undefined) continue;
    const parsed = parseMarkdownResource(source);
    const name = basename(filePath, '.md');
    const description =
      stringValue(parsed.frontmatter.description) ?? firstNonEmptyLine(parsed.body) ?? name;
    const argumentHint = stringValue(parsed.frontmatter['argument-hint']);
    prompts.set(name, {
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      filePath,
      content: parsed.body,
    });
  }
  return [...prompts.values()];
}

async function loadThemes(paths: string[]): Promise<PiThemeResource[]> {
  const themes = new Map<string, PiThemeResource>();
  for (const filePath of await discoverFiles(paths, '.json', false)) {
    const value = await readOptionalJson(filePath);
    if (!value) continue;
    const name = typeof value.name === 'string' ? value.name : basename(filePath, '.json');
    themes.set(name, { name, filePath, value });
  }
  return [...themes.values()];
}

async function discoverFiles(
  paths: string[],
  extension: string,
  recursive: boolean,
): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    const directFile = await readableFile(path);
    if (directFile && extname(path).toLowerCase() === extension) {
      files.push(path);
      continue;
    }
    const entries = await readDirectory(path);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (recursive) files.push(...(await discoverFiles([child], extension, true)));
      } else if (extname(entry.name).toLowerCase() === extension) {
        files.push(child);
      }
    }
  }
  return files;
}

async function readableFile(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isPathUnavailable(error)) return undefined;
    throw error;
  }
}

interface ParsedMarkdownResource {
  frontmatter: Record<string, string | boolean>;
  body: string;
}

function parseMarkdownResource(source: string): ParsedMarkdownResource {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: source.trim() };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { frontmatter: {}, body: source.trim() };

  const frontmatter: Record<string, string | boolean> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key) continue;
    if (rawValue === 'true' || rawValue === 'false') {
      frontmatter[key] = rawValue === 'true';
    } else {
      frontmatter[key] = unquote(rawValue);
    }
  }
  return {
    frontmatter,
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim();
}

/** Add usable Pi skills to the compiled conductor prompt. */
export function formatPiSkillsForPrompt(skills: PiSkillResource[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return '';
  return [
    '',
    '',
    '<pi_skills>',
    ...visible.flatMap((skill) => [
      `  <skill name="${escapeXml(skill.name)}" description="${escapeXml(skill.description)}" location="${escapeXml(skill.filePath)}">`,
      skill.content,
      '  </skill>',
    ]),
    '</pi_skills>',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Expand Pi prompt templates and explicit skill invocations for headless sends. */
export function expandPiResourcePrompt(
  prompt: string,
  resources: Pick<PiResources, 'prompts' | 'skills'>,
): string {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return prompt;
  const name = match[1]!;
  const args = splitPromptArguments(match[2] ?? '');
  if (name.startsWith('skill:')) {
    const skill = resources.skills.find((candidate) => candidate.name === name.slice('skill:'.length));
    if (!skill) return prompt;
    return `${substitutePromptArguments(skill.content, args)}${args.length > 0 ? `\n\n${args.join(' ')}` : ''}`;
  }
  const template = resources.prompts.find((candidate) => candidate.name === name);
  return template ? substitutePromptArguments(template.content, args) : prompt;
}

function splitPromptArguments(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (current) args.push(current);
  return args;
}

function substitutePromptArguments(content: string, args: string[]): string {
  const allArgs = args.join(' ');
  return content.replace(
    /\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultNumber, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultNumber) return args[Number(defaultNumber) - 1] || defaultValue;
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        return args.slice(start, sliceLength ? start + Number(sliceLength) : undefined).join(' ');
      }
      if (simple === 'ARGUMENTS' || simple === '@') return allArgs;
      return args[Number(simple) - 1] ?? '';
    },
  );
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
