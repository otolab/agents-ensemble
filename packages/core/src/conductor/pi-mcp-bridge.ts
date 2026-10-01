import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  McpServerConfig,
  McpServerConfigMap,
} from '../mcp/load-mcp-config.js';

/** The bridge dependency is intentionally exact-pinned in packages/core. */
export const PI_MCP_SDK_VERSION = '1.30.0';

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpContentText {
  type: 'text';
  text: string;
}

interface McpContentImage {
  type: 'image';
  data: string;
  mimeType: string;
}

interface McpContentAudio {
  type: 'audio';
  data: string;
  mimeType: string;
}

interface McpContentResource {
  type: 'resource';
  resource:
    | { uri: string; text: string; mimeType?: string }
    | { uri: string; blob: string; mimeType?: string };
}

interface McpContentResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  description?: string;
}

type McpContent =
  | McpContentText
  | McpContentImage
  | McpContentAudio
  | McpContentResource
  | McpContentResourceLink;

interface McpToolResult {
  content?: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface McpClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpToolDefinition[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface PiMcpBridgeSdk {
  Client: new (info: { name: string; version: string }) => McpClient;
  StdioClientTransport: new (options: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }) => unknown;
  StreamableHTTPClientTransport: new (
    url: URL,
    options?: { requestInit?: RequestInit },
  ) => unknown;
  SSEClientTransport: new (
    url: URL,
    options?: { requestInit?: RequestInit },
  ) => unknown;
}

/** Injectable only for unit tests; production uses the pinned SDK loader. */
export interface PiMcpBridgeDependencies {
  sdk?: PiMcpBridgeSdk;
  loadSdk?: () => Promise<PiMcpBridgeSdk>;
}

export interface PiMcpBridgeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface PiMcpBridge {
  readonly tools: AgentTool[];
  close(): Promise<void>;
}

interface ConnectedServer {
  readonly name: string;
  readonly client: McpClient;
}

/**
 * Load the harness-owned in-process Pi MCP bridge for one resolved mcp.json
 * snapshot. This is not a Pi ExtensionAPI extension.
 *
 * The bridge is deliberately in-memory: it does not write `.pi/mcp.json` or
 * mutate Pi settings. The Pi resource loader resolves user/project Pi
 * resources separately; this bridge remains the harness-owned connection for
 * the already-resolved ensemble MCP map.
 */
export async function createPiMcpBridge(
  mcpServers: McpServerConfigMap | undefined,
  options: PiMcpBridgeOptions,
  dependencies: PiMcpBridgeDependencies = {},
): Promise<PiMcpBridge | undefined> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return undefined;
  }

  const sdk =
    dependencies.sdk ?? (await loadMcpSdk(dependencies.loadSdk));
  const connectedServers: ConnectedServer[] = [];
  const tools: AgentTool[] = [];
  const usedToolNames = new Set<string>();

  try {
    for (const [serverName, config] of Object.entries(mcpServers)) {
      const client = new sdk.Client({
        name: 'agents-ensemble-pi-conductor',
        version: PI_MCP_SDK_VERSION,
      });
      connectedServers.push({ name: serverName, client });
      const transport = createTransport(sdk, serverName, config, options);
      await client.connect(transport);

      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const exposedName = uniqueToolName(serverName, tool.name, usedToolNames);
        tools.push(createPiMcpTool(client, serverName, tool, exposedName));
      }
    }
  } catch (error) {
    await closeClients(connectedServers);
    throw new Error(
      `Pi MCP bridge failed while loading server configuration: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return new LoadedPiMcpBridge(tools, connectedServers);
}

class LoadedPiMcpBridge implements PiMcpBridge {
  private closed = false;

  constructor(
    public readonly tools: AgentTool[],
    private readonly connectedServers: ConnectedServer[],
  ) {}

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await closeClients(this.connectedServers);
  }
}

async function loadMcpSdk(
  loader: () => Promise<PiMcpBridgeSdk> = importMcpSdk,
): Promise<PiMcpBridgeSdk> {
  try {
    return await loader();
  } catch (error) {
    throw new Error(
      `Pi MCP bridge is unavailable. Install @modelcontextprotocol/sdk@${PI_MCP_SDK_VERSION} and reinstall @agents-ensemble/core.`,
      { cause: error },
    );
  }
}

async function importMcpSdk(): Promise<PiMcpBridgeSdk> {
  const [client, stdio, streamableHttp, sse] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ]);
  return {
    Client: client.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    StreamableHTTPClientTransport:
      streamableHttp.StreamableHTTPClientTransport,
    SSEClientTransport: sse.SSEClientTransport,
  };
}

function createTransport(
  sdk: PiMcpBridgeSdk,
  serverName: string,
  config: McpServerConfig,
  options: PiMcpBridgeOptions,
): unknown {
  if (config.auth) {
    throw new Error(
      `MCP server "${serverName}" uses OAuth auth, which the Pi bridge does not support yet. Remove auth from the definition or use the Cursor backend.`,
    );
  }

  const env = options.env ?? process.env;
  const type = config.type ?? (config.command ? 'stdio' : 'http');
  if (type === 'stdio') {
    if (!config.command) {
      throw new Error(`MCP server "${serverName}" is missing command.`);
    }
    return new sdk.StdioClientTransport({
      command: expand(config.command, options.cwd, env),
      ...(config.args
        ? { args: config.args.map((value) => expand(value, options.cwd, env)) }
        : {}),
      env: mergeProcessEnvironment(config.env, options.cwd, env),
      cwd: config.cwd
        ? expand(config.cwd, options.cwd, env)
        : options.cwd,
    });
  }

  if (!config.url) {
    throw new Error(`MCP server "${serverName}" is missing url.`);
  }

  const requestInit = config.headers
    ? { headers: expandRecord(config.headers, options.cwd, env) }
    : undefined;
  const url = new URL(expand(config.url, options.cwd, env));
  if (type === 'sse') {
    return new sdk.SSEClientTransport(
      url,
      requestInit ? { requestInit } : undefined,
    );
  }
  if (type === 'http') {
    return new sdk.StreamableHTTPClientTransport(
      url,
      requestInit ? { requestInit } : undefined,
    );
  }

  throw new Error(
    `MCP server "${serverName}" uses unsupported transport type "${type}".`,
  );
}

function createPiMcpTool(
  client: McpClient,
  serverName: string,
  tool: McpToolDefinition,
  exposedName: string,
): AgentTool {
  return {
    name: exposedName,
    label: exposedName,
    description: tool.description
      ? `[MCP ${serverName}] ${tool.description}`
      : `MCP tool ${serverName}/${tool.name}`,
    // MCP input schemas are JSON Schema objects and are structurally
    // compatible with the TypeBox schema consumed by pi-agent-core.
    parameters: tool.inputSchema as AgentTool['parameters'],
    execute: async (_toolCallId, params, signal) => {
      const result = toMcpToolResult(
        await client.callTool(
          {
            name: tool.name,
            arguments: isRecord(params) ? params : {},
          },
          undefined,
          signal ? { signal } : undefined,
        ),
      );
      if (result.isError) {
        throw new Error(
          `MCP tool ${serverName}/${tool.name} returned an error: ${mcpErrorDetail(result)}`,
        );
      }
      return {
        content: toPiContent(result),
        details: {
          mcpServer: serverName,
          mcpTool: tool.name,
          ...(result.structuredContent
            ? { structuredContent: result.structuredContent }
            : {}),
        },
      };
    },
  };
}

function toPiContent(result: McpToolResult): Array<
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
> {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  > = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      content.push({ type: 'text', text: item.text });
    } else if (item.type === 'image') {
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    } else if (item.type === 'resource') {
      content.push({ type: 'text', text: resourceText(item) });
    } else if (item.type === 'resource_link') {
      content.push({
        type: 'text',
        text: `${item.name}: ${item.uri}${item.description ? ` (${item.description})` : ''}`,
      });
    } else if (item.type === 'audio') {
      content.push({
        type: 'text',
        text: `[MCP audio ${item.mimeType}] ${item.data}`,
      });
    }
  }
  if (content.length === 0 && result.structuredContent) {
    content.push({
      type: 'text',
      text: JSON.stringify(result.structuredContent),
    });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '(MCP tool returned no content.)' });
  }
  return content;
}

function resourceText(item: McpContentResource): string {
  if ('text' in item.resource) {
    return item.resource.text;
  }
  return `[MCP resource ${item.resource.uri}] ${item.resource.blob}`;
}

function uniqueToolName(
  serverName: string,
  toolName: string,
  usedNames: Set<string>,
): string {
  const base = `mcp_${sanitizeToolNamePart(serverName)}_${sanitizeToolNamePart(toolName)}`;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!sanitized) return 'tool';
  return /^[a-zA-Z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function mergeProcessEnvironment(
  configured: Record<string, string> | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    ...(configured ? expandRecord(configured, cwd, env) : {}),
  };
}

function expandRecord(
  record: Record<string, string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      expand(value, cwd, env),
    ]),
  );
}

function expand(value: string, cwd: string, env: NodeJS.ProcessEnv): string {
  return value
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => env[name] ?? '')
    .replace(/\$\{workspaceFolder\}/g, cwd);
}

async function closeClients(servers: ConnectedServer[]): Promise<void> {
  await Promise.allSettled(servers.map(({ client }) => client.close()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMcpToolResult(value: unknown): McpToolResult {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...(Array.isArray(value.content)
      ? { content: value.content as McpContent[] }
      : {}),
    ...(isRecord(value.structuredContent)
      ? { structuredContent: value.structuredContent }
      : {}),
    ...(value.isError === true ? { isError: true } : {}),
  };
}

function mcpErrorDetail(result: McpToolResult): string {
  const text = (result.content ?? [])
    .filter((item): item is McpContentText => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  if (text) return text;
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return 'the MCP server reported an error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
