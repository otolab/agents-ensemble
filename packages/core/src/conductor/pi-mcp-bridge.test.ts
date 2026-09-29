import { describe, expect, it, vi } from 'vitest';
import {
  createPiMcpBridge,
  PI_MCP_SDK_VERSION,
  type PiMcpBridgeSdk,
} from './pi-mcp-bridge.js';

interface FakeTransport {
  readonly kind: string;
  readonly options: unknown;
}

class FakeStdioTransport implements FakeTransport {
  readonly kind = 'stdio';

  constructor(readonly options: unknown) {}
}

class FakeHttpTransport implements FakeTransport {
  readonly kind = 'http';

  constructor(
    readonly url: URL,
    readonly options: unknown,
  ) {}
}

class FakeSseTransport implements FakeTransport {
  readonly kind = 'sse';

  constructor(
    readonly url: URL,
    readonly options: unknown,
  ) {}
}

class FakeClient {
  static readonly clients: FakeClient[] = [];
  static tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];

  readonly connect = vi.fn(async (_transport: unknown) => {});
  readonly listTools = vi.fn(async () => ({ tools: FakeClient.tools }));
  readonly callTool = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'MCP result' }],
    structuredContent: { ok: true },
  }));
  readonly close = vi.fn(async () => {});

  constructor(readonly info: { name: string; version: string }) {
    FakeClient.clients.push(this);
  }
}

function fakeSdk(): PiMcpBridgeSdk {
  return {
    Client: FakeClient,
    StdioClientTransport: FakeStdioTransport,
    StreamableHTTPClientTransport: FakeHttpTransport,
    SSEClientTransport: FakeSseTransport,
  };
}

describe('createPiMcpBridge', () => {
  it('does not load a bridge when MCP is not configured', async () => {
    await expect(
      createPiMcpBridge(undefined, { cwd: '/repo' }, { sdk: fakeSdk() }),
    ).resolves.toBeUndefined();
    expect(FakeClient.clients).toHaveLength(0);
  });

  it('does not load a bridge for an empty MCP map', async () => {
    await expect(
      createPiMcpBridge({}, { cwd: '/repo' }, { sdk: fakeSdk() }),
    ).resolves.toBeUndefined();
    expect(FakeClient.clients).toHaveLength(0);
  });

  it('fails fast with the pinned SDK guidance when the SDK import is unavailable', async () => {
    const loadSdk = vi
      .fn()
      .mockRejectedValue(new Error('ERR_MODULE_NOT_FOUND'));

    await expect(
      createPiMcpBridge(
        { docs: { type: 'stdio', command: 'mcp-server' } },
        { cwd: '/repo' },
        { loadSdk },
      ),
    ).rejects.toThrow(
      `Pi MCP bridge is unavailable. Install @modelcontextprotocol/sdk@${PI_MCP_SDK_VERSION}`,
    );
    expect(loadSdk).toHaveBeenCalledOnce();
  });

  it('connects from the resolved stdio definition and exposes discovered tools', async () => {
    FakeClient.clients.length = 0;
    FakeClient.tools = [
      {
        name: 'lookup-item',
        description: 'Look up an item',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    ];
    const env = { MCP_TEST_TOKEN: 'secret-value' };

    const bridge = await createPiMcpBridge(
      {
        docs: {
          type: 'stdio',
          command: 'mcp-server',
          args: ['${workspaceFolder}', '${env:MCP_TEST_TOKEN}'],
          env: { TOKEN: '${env:MCP_TEST_TOKEN}' },
          cwd: '${workspaceFolder}',
        },
      },
      { cwd: '/repo', env },
      { sdk: fakeSdk() },
    );

    expect(bridge).toBeDefined();
    expect(bridge?.tools.map((tool) => tool.name)).toEqual([
      'mcp_docs_lookup_item',
    ]);
    expect(FakeClient.clients[0]?.info).toEqual({
      name: 'agents-ensemble-pi-conductor',
      version: PI_MCP_SDK_VERSION,
    });
    const transport = FakeClient.clients[0]?.connect.mock.calls[0]?.[0] as FakeStdioTransport;
    expect(transport.kind).toBe('stdio');
    expect(transport.options).toMatchObject({
      command: 'mcp-server',
      args: ['/repo', 'secret-value'],
      cwd: '/repo',
      env: { TOKEN: 'secret-value' },
    });

    const result = await bridge!.tools[0]!.execute('call-1', { id: '42' });
    expect(FakeClient.clients[0]?.callTool).toHaveBeenCalledWith(
      { name: 'lookup-item', arguments: { id: '42' } },
      undefined,
      undefined,
    );
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'MCP result' }],
      details: {
        mcpServer: 'docs',
        mcpTool: 'lookup-item',
        structuredContent: { ok: true },
      },
    });

    await bridge?.close();
    await bridge?.close();
    expect(FakeClient.clients[0]?.close).toHaveBeenCalledOnce();
  });

  it('propagates MCP client exceptions from AgentTool execution', async () => {
    FakeClient.clients.length = 0;
    FakeClient.tools = [
      {
        name: 'lookup-item',
        inputSchema: { type: 'object' },
      },
    ];
    const bridge = await createPiMcpBridge(
      { docs: { type: 'stdio', command: 'mcp-server' } },
      { cwd: '/repo' },
      { sdk: fakeSdk() },
    );
    const callError = new Error('connection lost');
    FakeClient.clients[0]?.callTool.mockRejectedValueOnce(callError);

    await expect(bridge!.tools[0]!.execute('call-1', {})).rejects.toBe(callError);
    await bridge?.close();
  });

  it('propagates MCP isError results as AgentTool failures', async () => {
    FakeClient.clients.length = 0;
    FakeClient.tools = [
      {
        name: 'lookup-item',
        inputSchema: { type: 'object' },
      },
    ];
    const bridge = await createPiMcpBridge(
      { docs: { type: 'stdio', command: 'mcp-server' } },
      { cwd: '/repo' },
      { sdk: fakeSdk() },
    );
    FakeClient.clients[0]?.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text' as const, text: 'lookup failed' }],
    });

    await expect(bridge!.tools[0]!.execute('call-1', {})).rejects.toThrow(
      'MCP tool docs/lookup-item returned an error: lookup failed',
    );
    await bridge?.close();
  });

  it('selects HTTP and SSE transports from the same server definitions', async () => {
    FakeClient.clients.length = 0;
    FakeClient.tools = [];

    const bridge = await createPiMcpBridge(
      {
        http: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${env:TOKEN}' },
        },
        sse: {
          type: 'sse',
          url: 'https://example.test/sse',
        },
      },
      { cwd: '/repo', env: { TOKEN: 'token' } },
      { sdk: fakeSdk() },
    );

    const http = FakeClient.clients[0]?.connect.mock.calls[0]?.[0] as FakeHttpTransport;
    const sse = FakeClient.clients[1]?.connect.mock.calls[0]?.[0] as FakeSseTransport;
    expect(http.kind).toBe('http');
    expect(http.url.toString()).toBe('https://example.test/mcp');
    expect(http.options).toEqual({
      requestInit: { headers: { Authorization: 'Bearer token' } },
    });
    expect(sse.kind).toBe('sse');
    expect(sse.url.toString()).toBe('https://example.test/sse');

    await bridge?.close();
  });

  it('fails clearly for OAuth definitions and closes already connected servers', async () => {
    FakeClient.clients.length = 0;
    FakeClient.tools = [];

    await expect(
      createPiMcpBridge(
        {
          first: { type: 'stdio', command: 'first-server' },
          oauth: {
            type: 'http',
            url: 'https://example.test/mcp',
            auth: { CLIENT_ID: 'client-id' },
          },
        },
        { cwd: '/repo' },
        { sdk: fakeSdk() },
      ),
    ).rejects.toThrow('OAuth auth');
    expect(FakeClient.clients[0]?.close).toHaveBeenCalledOnce();
  });
});
