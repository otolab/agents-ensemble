import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { PiConductorAgent, loadPiMcpConfig } from './pi-conductor-agent.js';
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

describe('shared mcp.json backend path', () => {
  it('passes one resolved stdio definition to Cursor and the official Pi MCP extension shape', async () => {
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
    const piConfig = loadPiMcpConfig(mcpServers);

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
    expect(piConfig).toEqual({
      autoEnableCodemode: true,
      errors: [],
      servers: [
        {
          name: 'representative',
          source: '<agents-ensemble-resolved-mcp.json>',
          scope: 'project',
          config: {
            type: 'stdio',
            command: 'fixture-mcp',
            args: ['--shared'],
          },
        },
      ],
    });
    expect(cursorResult).toMatchObject({
      status: 'finished',
      result: SHARED_RESULT,
    });

    await cursor.close();
  });

  it('exposes a resolved stdio server through the real Pi MCP extension', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcp-pi-extension-'));
    const agentDir = join(cwd, 'pi-agent');
    await mkdir(agentDir, { recursive: true });
    const serverScript = String.raw`
      const readline = require('node:readline');
      const tools = [{
        name: 'echo',
        description: 'Echo the supplied text',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        }
      }];
      const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        if (message.method === 'initialize') {
          send(message.id, {
            protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture-mcp', version: '1.0.0' }
          });
        } else if (message.method === 'tools/list') {
          send(message.id, { tools });
        } else if (message.method === 'tools/call') {
          send(message.id, {
            content: [{ type: 'text', text: message.params?.arguments?.text ?? '' }]
          });
        } else if (message.method === 'ping') {
          send(message.id, {});
        } else {
          fail(message.id, 'method not found');
        }
      });
    `;
    const mcpServers = {
      representative: {
        type: 'stdio' as const,
        command: process.execPath,
        args: ['-e', serverScript],
      },
    };
    const piConfig = loadPiMcpConfig(mcpServers);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const model = {
      id: 'fixture-model',
      name: 'Fixture model',
      provider: 'fixture',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1_024,
    } as Model<any>;
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'fixture system prompt',
      extensionFactories: [
        createMcpExtension({
          loadConfig: () => piConfig,
          logPath: join(cwd, 'mcp.log'),
          startupWaitMs: 2_000,
        }),
        createCodemodeExtension({ mode: 'on' }),
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      noTools: 'builtin',
    });
    await session.bindExtensions({});

    let echo = session.getToolDefinition('mcp__representative__echo');
    for (let attempt = 0; !echo && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      echo = session.getToolDefinition('mcp__representative__echo');
    }
    expect(echo).toBeDefined();
    await expect(
      echo!.execute('call-1', { text: 'shared-result' }, new AbortController().signal),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'shared-result' }],
    });

    session.dispose();
  });

  it('fails Pi conductor startup with the official MCP connection error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcp-pi-unreachable-'));
    const agentDir = join(cwd, 'pi-agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture-model' }),
    );
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1/v1',
            models: [{ id: 'fixture-model', name: 'Fixture model' }],
          },
        },
      }),
    );

    await expect(
      PiConductorAgent.create({
        cwd,
        pi: { agentDir },
        modelId: 'fixture/fixture-model',
        systemPrompt: 'fixture system prompt',
        mcpServers: {
          unreachable: {
            type: 'stdio',
            command: process.execPath,
            args: ['-e', 'process.exit(17)'],
          },
        },
      }),
    ).rejects.toThrow(/Pi MCP startup failed|MCP server "unreachable".*failed to connect/i);
  });
});
