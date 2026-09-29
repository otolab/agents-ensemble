import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createPiMcpBridge,
  type PiMcpBridgeSdk,
} from './pi-mcp-bridge.js';
import { resolveMcpServers } from '../mcp/load-mcp-config.js';

const { mockCursorCreate, mockCursorResume } = vi.hoisted(() => ({
  mockCursorCreate: vi.fn(),
  mockCursorResume: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: mockCursorCreate,
    resume: mockCursorResume,
  },
  AuthenticationError: class AuthenticationError extends Error {},
  CursorAgentError: class CursorAgentError extends Error {},
}));

vi.mock('./configure-cursor-sdk-env.js', () => ({
  ensureCursorSdkProxy: vi.fn(),
  ensureCursorSdkRipgrepPath: vi.fn(),
}));

import { CursorSdkConductorAgent } from './cursor-sdk-conductor-agent.js';

const SHARED_RESULT = 'shared-stdio-result';

class FakeStdioTransport {
  constructor(readonly options: unknown) {}
}

class FakeHttpTransport {
  constructor(
    readonly url: URL,
    readonly options: unknown,
  ) {}
}

class FakeSseTransport {
  constructor(
    readonly url: URL,
    readonly options: unknown,
  ) {}
}

class FakeMcpClient {
  static readonly clients: FakeMcpClient[] = [];

  readonly connect = vi.fn(async (_transport: unknown) => {});
  readonly listTools = vi.fn(async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Return the shared fixture result.',
        inputSchema: { type: 'object' },
      },
    ],
  }));
  readonly callTool = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: SHARED_RESULT }],
  }));
  readonly close = vi.fn(async () => {});

  constructor(readonly info: { name: string; version: string }) {
    FakeMcpClient.clients.push(this);
  }
}

function fakeMcpSdk(): PiMcpBridgeSdk {
  return {
    Client: FakeMcpClient,
    StdioClientTransport: FakeStdioTransport,
    StreamableHTTPClientTransport: FakeHttpTransport,
    SSEClientTransport: FakeSseTransport,
  };
}

describe('shared mcp.json backend path', () => {
  it('executes the same resolved stdio definition through Cursor inline MCP and Pi bridge', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcp-backend-vertical-'));
    const projectMcpRoot = join(cwd, '.agents');
    await mkdir(projectMcpRoot, { recursive: true });
    await writeFile(
      join(projectMcpRoot, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          representative: {
            type: 'stdio',
            command: 'fixture-mcp',
            args: ['--shared'],
          },
        },
      }),
    );

    const mcpServers = await resolveMcpServers(cwd, {
      userEnsembleRoot: join(cwd, 'user-ensemble'),
    });

    FakeMcpClient.clients.length = 0;
    const piBridge = await createPiMcpBridge(
      mcpServers,
      { cwd },
      { sdk: fakeMcpSdk() },
    );
    const piToolResult = await piBridge!.tools[0]!.execute('pi-call', {});

    let cursorOptions: any;
    const cursorAgent = {
      agentId: 'cursor-agent',
      getUsage: vi.fn().mockResolvedValue({}),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };
    mockCursorCreate.mockImplementationOnce(async (options) => {
      cursorOptions = options;
      const definition = options.mcpServers?.representative;
      const result =
        definition?.command === 'fixture-mcp' &&
        definition.args?.[0] === '--shared'
          ? SHARED_RESULT
          : 'missing-inline-mcp';
      return {
        ...cursorAgent,
        send: vi.fn().mockResolvedValue({
          id: 'cursor-run',
          wait: vi.fn().mockResolvedValue({
            status: 'finished',
            result,
            model: { id: 'fixture-model' },
          }),
        }),
      };
    });

    const cursor = await CursorSdkConductorAgent.create({
      cwd,
      modelId: 'fixture-model',
      systemPrompt: 'system',
      mcpServers,
    });
    const cursorResult = await cursor.send('use representative echo');

    expect(cursorOptions.mcpServers).toEqual(mcpServers);
    expect(FakeMcpClient.clients[0]?.connect.mock.calls[0]?.[0]).toMatchObject({
      options: {
        command: 'fixture-mcp',
        args: ['--shared'],
      },
    });
    expect(cursorResult).toMatchObject({
      status: 'finished',
      result: SHARED_RESULT,
    });
    expect(piToolResult.content).toEqual([
      { type: 'text', text: SHARED_RESULT },
    ]);

    await cursor.close();
    await piBridge?.close();
  });
});
