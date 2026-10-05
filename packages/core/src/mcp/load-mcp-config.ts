import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENSEMBLE_DIR } from '../profile/profile-paths.js';

export const MCP_CONFIG_FILE = 'mcp.json';
export const PROJECT_MCP_CONFIG_DIR = '.agents';

/** MCP server definition shared by the Cursor SDK and Pi backends. */
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: {
    CLIENT_ID: string;
    CLIENT_SECRET?: string;
    scopes?: string[];
  };
}

/** Resolved MCP server definitions keyed by the server name in mcp.json. */
export type McpServerConfigMap = Record<string, McpServerConfig>;

/** @deprecated Use `McpServerConfigMap` instead. */
export type McpServers = McpServerConfigMap;

export interface McpConfig {
  mcpServers: McpServerConfigMap;
}

export interface McpConfigLogger {
  warn(message: string): void;
}

export interface LoadMcpConfigOptions {
  /** テスト用。既定は `~/.ensemble`。 */
  userEnsembleRoot?: string;
  /** テスト用。既定は `console`。 */
  logger?: McpConfigLogger;
}

function userMcpConfigPath(options: LoadMcpConfigOptions): string {
  const root = options.userEnsembleRoot ?? join(homedir(), ENSEMBLE_DIR);
  return join(root, MCP_CONFIG_FILE);
}

function projectMcpConfigPath(repoRoot: string): string {
  return join(repoRoot, PROJECT_MCP_CONFIG_DIR, MCP_CONFIG_FILE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isPlainObject(value)) {
    return false;
  }

  const type = value.type;
  if (
    type !== undefined &&
    type !== 'stdio' &&
    type !== 'http' &&
    type !== 'sse'
  ) {
    return false;
  }

  const hasCommand = 'command' in value;
  const hasUrl = 'url' in value;
  if (hasCommand === hasUrl) {
    return false;
  }

  if (hasCommand) {
    if (type !== undefined && type !== 'stdio') {
      return false;
    }
    if (!isNonEmptyString(value.command)) {
      return false;
    }
    if (value.args !== undefined && !isStringArray(value.args)) {
      return false;
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      return false;
    }
    if (value.cwd !== undefined && !isNonEmptyString(value.cwd)) {
      return false;
    }
    return true;
  }

  if (type !== undefined && type !== 'http' && type !== 'sse') {
    return false;
  }
  if (!isNonEmptyString(value.url)) {
    return false;
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    return false;
  }
  if (value.auth !== undefined) {
    if (!isPlainObject(value.auth) || !isNonEmptyString(value.auth.CLIENT_ID)) {
      return false;
    }
    if (
      value.auth.CLIENT_SECRET !== undefined &&
      typeof value.auth.CLIENT_SECRET !== 'string'
    ) {
      return false;
    }
    if (value.auth.scopes !== undefined && !isStringArray(value.auth.scopes)) {
      return false;
    }
  }
  return true;
}

function parseMcpConfig(raw: unknown): McpConfig | undefined {
  if (!isPlainObject(raw) || !isPlainObject(raw.mcpServers)) {
    return undefined;
  }

  const entries = Object.entries(raw.mcpServers);
  if (!entries.every(([name, server]) => name !== '' && isMcpServerConfig(server))) {
    return undefined;
  }

  return {
    mcpServers: Object.fromEntries(entries) as McpServerConfigMap,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function warnInvalidConfig(
  logger: McpConfigLogger,
  path: string,
  reason: string,
): void {
  logger.warn(`[mcp] Ignoring invalid MCP config at ${path}: ${reason}`);
}

async function readMcpConfigFile(
  path: string,
  logger: McpConfigLogger,
): Promise<McpConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    warnInvalidConfig(logger, path, `could not be read (${errorMessage(error)})`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    warnInvalidConfig(logger, path, `invalid JSON (${errorMessage(error)})`);
    return undefined;
  }

  const config = parseMcpConfig(parsed);
  if (!config) {
    warnInvalidConfig(logger, path, 'expected an mcpServers object with valid server entries');
    return undefined;
  }
  return config;
}

function mergeMcpConfig(base: McpConfig, override: McpConfig): McpConfig {
  return {
    mcpServers: {
      ...base.mcpServers,
      ...override.mcpServers,
    },
  };
}

/**
 * user `~/.ensemble/mcp.json` → project `<repoRoot>/.agents/mcp.json` の順で
 * `mcpServers` をサーバー名単位にマージする。欠損または不正な層は無視する。
 */
export async function loadMcpConfig(
  repoRoot: string,
  options: LoadMcpConfigOptions = {},
): Promise<McpConfig> {
  const logger = options.logger ?? console;
  let merged: McpConfig = { mcpServers: {} };

  const userConfig = await readMcpConfigFile(userMcpConfigPath(options), logger);
  if (userConfig) {
    merged = mergeMcpConfig(merged, userConfig);
  }

  const projectConfig = await readMcpConfigFile(
    projectMcpConfigPath(repoRoot),
    logger,
  );
  if (projectConfig) {
    merged = mergeMcpConfig(merged, projectConfig);
  }

  return merged;
}

/**
 * Return the resolved server map for any conductor backend.
 *
 * The map intentionally retains the mcp.json server definitions. Each backend
 * adapts the same snapshot to its own tool/transport representation.
 */
export async function resolveMcpServers(
  repoRoot: string,
  options: LoadMcpConfigOptions = {},
): Promise<McpServerConfigMap> {
  const config = await loadMcpConfig(repoRoot, options);
  return config.mcpServers;
}

/**
 * Return a stable digest for the harness-resolved MCP server map.
 *
 * The digest is persisted in a session sidecar instead of the map itself so
 * that credentials and other MCP values are not copied into session state.
 * Object keys are sorted while array order is preserved.
 */
export function computeMcpConfigDigest(servers: McpServerConfigMap): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeMcpValue(servers)))
    .digest('hex');
}

function canonicalizeMcpValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeMcpValue(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeMcpValue(value[key])]),
    );
  }
  return value;
}

/** @deprecated Use `resolveMcpServers` instead. */
export const resolveMcpServersForSdk = resolveMcpServers;
