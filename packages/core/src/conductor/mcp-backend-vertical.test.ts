import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
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

  it('resolves Cursor env and workspace placeholders before handing config to Pi', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcp-pi-placeholders-'));
    const piConfig = loadPiMcpConfig(
      {
        stdio: {
          type: 'stdio',
          command: '${workspaceFolder}/bin/mcp-server',
          args: ['--root', '${workspaceFolder}', '--token', '${env:MCP_TOKEN}'],
          cwd: '${workspaceFolder}/server',
          env: { MCP_TOKEN: '${env:MCP_TOKEN}' },
        },
        http: {
          type: 'http',
          url: 'https://mcp.example.test/${workspaceFolderBasename}',
          headers: { Authorization: 'Bearer ${env:MCP_TOKEN}' },
        },
      },
      { cwd, env: { MCP_TOKEN: 'secret-token' } },
    );

    expect(piConfig.servers).toEqual([
      expect.objectContaining({
        name: 'stdio',
        config: expect.objectContaining({
          command: `${cwd}/bin/mcp-server`,
          args: ['--root', cwd, '--token', 'secret-token'],
          cwd: `${cwd}/server`,
          env: { MCP_TOKEN: 'secret-token' },
        }),
      }),
      expect.objectContaining({
        name: 'http',
        config: expect.objectContaining({
          url: `https://mcp.example.test/${basename(cwd)}`,
          headers: { Authorization: 'Bearer secret-token' },
        }),
      }),
    ]);
    expect(JSON.stringify(piConfig)).not.toContain('${env:');
    expect(JSON.stringify(piConfig)).not.toContain('${workspaceFolder');
  });

  it('rejects a missing Cursor env placeholder instead of passing it literally to Pi', () => {
    expect(() =>
      loadPiMcpConfig(
        {
          representative: {
            type: 'stdio',
            command: 'fixture-mcp',
            env: { API_KEY: '${env:MISSING_MCP_TOKEN}' },
          },
        },
        { cwd: '/workspace', env: {} },
      ),
    ).toThrow(
      'MCP server "representative" references missing environment variable "MISSING_MCP_TOKEN" in env.API_KEY.',
    );
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
    const piConfig = loadPiMcpConfig(mcpServers, {
      exposure: 'direct',
      autoEnableCodemode: false,
    });
    expect(piConfig).toMatchObject({
      autoEnableCodemode: false,
      servers: [
        {
          name: 'representative',
          config: { exposure: 'direct' },
        },
      ],
    });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const fakeModelProvider = fauxProvider({
      api: 'fixture',
      provider: 'fixture',
      models: [{ id: 'fixture-model', input: ['text'] }],
    });
    let modelDeclaredTools: string[] = [];
    let mcpToolResult = '';
    let workspaceToolResult = '';
    fakeModelProvider.setResponses([
      (context) => {
        modelDeclaredTools = context.messages
          .filter((message) => message.role === 'system')
          .flatMap((message) => message.toolsAdded ?? [])
          .map((tool) => tool.name);
        return fauxAssistantMessage(
          [
            fauxToolCall('mcp__representative__echo', {
              text: 'model-invoked-mcp-tool',
            }),
            fauxToolCall('read_operator_workspace_file', {}),
          ],
          { stopReason: 'toolUse' },
        );
      },
      (context) => {
        const toolResults = context.messages.filter(
          (message) => message.role === 'toolResult',
        );
        mcpToolResult =
          toolResults
            .find((message) => message.toolName === 'mcp__representative__echo')
            ?.content.map((block) => (block.type === 'text' ? block.text : ''))
            .join('') ?? '';
        workspaceToolResult =
          toolResults
            .find((message) => message.toolName === 'read_operator_workspace_file')
            ?.content.map((block) => (block.type === 'text' ? block.text : ''))
            .join('') ?? '';
        return fauxAssistantMessage(
          'MCP and workspace tool results received',
        );
      },
    ]);
    runtime.registerNativeProvider(fakeModelProvider.provider);
    const model = runtime.getModel('fixture', 'fixture-model');
    if (!model) throw new Error('Fixture model was not registered.');
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
      customTools: [
        {
          name: 'read_operator_workspace_file',
          label: 'read_operator_workspace_file',
          description: 'Read an operator workspace file',
          parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
          execute: async () => ({
            content: [{ type: 'text', text: 'workspace-file-result' }],
          }),
        },
      ],
    });
    await session.bindExtensions({});

    let echo = session.getToolDefinition('mcp__representative__echo');
    for (let attempt = 0; !echo && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      echo = session.getToolDefinition('mcp__representative__echo');
    }
    expect(echo).toBeDefined();
    const registeredTools = session.getAllTools();
    expect(registeredTools.find((tool) => tool.name === echo!.name)).toMatchObject({
      exposure: 'direct',
    });
    const modelTools = session.getActiveToolNames();
    const callableTools = session.getCallableToolNames();
    expect(modelTools).toContain(echo!.name);
    expect(modelTools).toContain('read_operator_workspace_file');
    expect(session.getToolDefinition('codemode')).toBeUndefined();
    expect(modelTools).not.toContain('read');
    expect(modelTools).not.toContain('bash');
    expect(modelTools).not.toContain('edit');
    expect(modelTools).not.toContain('write');
    expect(callableTools).not.toContain('read');
    expect(callableTools).not.toContain('bash');
    expect(callableTools).not.toContain('edit');
    expect(callableTools).not.toContain('write');
    await session.prompt('Call the MCP and workspace tools.', {
      expandPromptTemplates: false,
    });
    expect(modelDeclaredTools).toContain(echo!.name);
    expect(modelDeclaredTools).toContain('read_operator_workspace_file');
    expect(modelDeclaredTools).not.toContain('read');
    expect(modelDeclaredTools).not.toContain('bash');
    expect(modelDeclaredTools).not.toContain('edit');
    expect(modelDeclaredTools).not.toContain('write');
    expect(modelDeclaredTools).not.toContain('codemode');
    expect(mcpToolResult).toBe('model-invoked-mcp-tool');
    expect(workspaceToolResult).toBe('workspace-file-result');
    expect(session.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: 'MCP and workspace tool results received',
          }),
        ]),
      }),
    );

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
        issueUrl: 'https://github.com/org/repo/issues/1',
        pi: { agentDir },
        modelId: 'fixture/fixture-model',
        systemPrompt: 'fixture system prompt',
        builtinTools: false,
        mcpServers: {
          unreachable: {
            type: 'stdio',
            command: process.execPath,
            args: ['-e', 'process.exit(17)'],
          },
        },
      }),
    ).rejects.toThrow(/Pi MCP startup failed|MCP server "unreachable".*failed to connect/i);

    await expect(
      PiConductorAgent.create({
        cwd,
        issueUrl: 'https://github.com/org/repo/issues/1',
        pi: { agentDir },
        modelId: 'fixture/fixture-model',
        systemPrompt: 'fixture system prompt',
        builtinTools: false,
        mcpServers: {
          'unreachable-http': {
            type: 'http',
            url: 'http://127.0.0.1:1/mcp',
          },
        },
      }),
    ).rejects.toThrow(
      /Pi MCP startup failed|MCP server "unreachable-http".*failed to connect/i,
    );
  });
});
