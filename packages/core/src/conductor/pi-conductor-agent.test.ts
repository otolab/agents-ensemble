import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateAgentSession,
  mockCreateMcpExtension,
  mockCreateExtension,
  mockSessionManagerCreate,
  mockSessionManagerFindById,
  mockSessionManagerOpen,
  mockGetEnvApiKey,
  mockGetModel,
  mockGetModels,
  mockGetProviders,
} = vi.hoisted(() => ({
  mockCreateAgentSession: vi.fn(),
  mockCreateMcpExtension: vi.fn(),
  mockCreateExtension: vi.fn(() => () => {}),
  mockSessionManagerCreate: vi.fn(),
  mockSessionManagerFindById: vi.fn(),
  mockSessionManagerOpen: vi.fn(),
  mockGetEnvApiKey: vi.fn(),
  mockGetModel: vi.fn(),
  mockGetModels: vi.fn(),
  mockGetProviders: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  findEnvKeys: vi.fn(() => undefined),
  getEnvApiKey: mockGetEnvApiKey,
  getModel: mockGetModel,
  getModels: mockGetModels,
  getProviders: mockGetProviders,
}));

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  );
  return {
    ...actual,
    createAgentSession: mockCreateAgentSession,
    createMcpExtension: mockCreateMcpExtension,
    createCodemodeExtension: mockCreateExtension,
    createToolSearchExtension: mockCreateExtension,
    SessionManager: {
      ...actual.SessionManager,
      create: mockSessionManagerCreate,
      findById: mockSessionManagerFindById,
      open: mockSessionManagerOpen,
    },
  };
});

import {
  PiConductorAgent,
  resolvePiModelConfig,
} from './pi-conductor-agent.js';

describe('PiConductorAgent', () => {
  let cwd = '';
  let agentDir = '';
  let fakeSession: any;
  let fakeSessionManager: any;
  let sessionListener: ((event: any) => void) | undefined;
  let mcpLoadConfig: (() => any) | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'pi-conductor-project-'));
    agentDir = join(cwd, 'user-pi');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );

    sessionListener = undefined;
    fakeSession = {
      state: { messages: [] },
      subscribe: vi.fn((listener: (event: any) => void) => {
        sessionListener = listener;
        return vi.fn();
      }),
      prompt: vi.fn(),
      reload: vi.fn().mockResolvedValue(undefined),
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
    fakeSessionManager = {};
    mockSessionManagerCreate.mockReset();
    mockSessionManagerCreate.mockReturnValue(fakeSessionManager);
    mockSessionManagerFindById.mockReset();
    mockSessionManagerOpen.mockReset();
    mockSessionManagerOpen.mockReturnValue(fakeSessionManager);
    mockCreateAgentSession.mockReset();
    mockCreateAgentSession.mockResolvedValue({
      session: fakeSession,
      extensionsResult: { errors: [] },
    });
    mockCreateMcpExtension.mockReset();
    mockCreateMcpExtension.mockImplementation((options: { loadConfig: () => unknown }) => {
      mcpLoadConfig = options.loadConfig;
      return () => {};
    });
    mockCreateExtension.mockClear();
    mockGetEnvApiKey.mockReset();
    mockGetEnvApiKey.mockReturnValue(undefined);
    mockGetModels.mockReset();
    mockGetModels.mockReturnValue([]);
    mockGetProviders.mockReset();
    mockGetProviders.mockReturnValue([]);
    mockGetModel.mockReset();
    mockGetModel.mockReturnValue({
      id: 'model-1',
      name: 'Model 1',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a Pi 1.x AgentSession and injects the resolved MCP map into the official extension', async () => {
    const mcpServers = {
      representative: {
        type: 'stdio' as const,
        command: 'fixture-mcp',
        args: ['--shared'],
      },
    };
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'compiled system prompt',
      mcpServers,
      customTools: {
        prompt_worker: {
          name: 'prompt_worker',
          description: 'Dispatch to worker',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({
            content: [{ type: 'text' as const, text: 'dispatched' }],
          }),
        },
      },
    });

    expect(mockCreateAgentSession).toHaveBeenCalledOnce();
    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    expect(sessionOptions.model).toMatchObject({
      provider: 'anthropic',
      id: 'model-1',
    });
    expect(sessionOptions.noTools).toBe('builtin');
    expect(sessionOptions.customTools).toEqual([
      expect.objectContaining({ name: 'prompt_worker' }),
    ]);
    expect(sessionOptions.sessionStartEvent).toMatchObject({
      type: 'session_start',
      reason: 'startup',
    });
    expect(mcpLoadConfig).toBeDefined();
    expect(mcpLoadConfig?.()).toEqual({
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

    const finalMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'started' }],
      model: 'model-1',
      stopReason: 'stop',
      usage: {
        input: 10,
        output: 4,
        totalTokens: 14,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { total: 0.25 },
      },
    };
    fakeSession.prompt.mockImplementation(async () => {
      sessionListener?.({
        type: 'tool_execution_start',
        toolName: 'prompt_worker',
        toolCallId: 'call-1',
      });
      sessionListener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'started' },
      });
      fakeSession.state.messages = [finalMessage];
      sessionListener?.({
        type: 'agent_end',
        messages: [finalMessage],
        willRetry: false,
      });
    });

    const onToolCallStarted = vi.fn();
    const onStreamText = vi.fn();
    // The factory is created above, so this instance has no stream callback;
    // the send/event contract is asserted through the tool callback and result.
    const result = await conductor.send('kickoff', { onToolCallStarted });
    expect(fakeSession.prompt).toHaveBeenCalledWith('kickoff', {
      expandPromptTemplates: false,
      source: 'rpc',
    });
    expect(onToolCallStarted).toHaveBeenCalledWith({
      runId: result.runId,
      tool: 'prompt_worker',
      callId: 'call-1',
    });
    expect(result).toMatchObject({
      status: 'finished',
      result: 'started',
      modelId: 'model-1',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    });
    expect(await conductor.getUsage()).toEqual({
      cost: { rawCostCents: 25, chargedCents: 25 },
    });
    await conductor.close();
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
    void onStreamText;
  });

  it('rejects SSE before the Pi extension is started', async () => {
    const conductorPromise = PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      mcpServers: {
        legacy: { type: 'sse', url: 'https://example.invalid/sse' },
      },
    });

    await expect(conductorPromise).rejects.toThrow(/SSE.*Pi 1\.0.*stdio.*HTTP/i);
  });

  it('resumes through SessionManager with the same conductor id and refreshes the prompt path', async () => {
    mockSessionManagerFindById.mockReturnValue('/tmp/pi-session.jsonl');
    const conductor = await PiConductorAgent.resume('session-392', {
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'recompiled system prompt',
    });

    expect(mockSessionManagerFindById).toHaveBeenCalledWith(
      cwd,
      'session-392',
      join(cwd, '.ensemble/pi/sessions'),
    );
    expect(mockSessionManagerOpen).toHaveBeenCalledWith(
      '/tmp/pi-session.jsonl',
      join(cwd, '.ensemble/pi/sessions'),
      cwd,
    );
    expect(mockCreateAgentSession.mock.calls[0]![0].sessionStartEvent).toMatchObject({
      type: 'session_start',
      reason: 'resume',
      previousSessionFile: '/tmp/pi-session.jsonl',
    });
    await conductor.close();
  });

  it('keeps custom Pi resource model and auth resolution on the v1 runtime path', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'local', defaultModel: 'review-model' }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: '$LOCAL_MODEL_KEY',
            authHeader: true,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );
    mockGetModel.mockReturnValue(undefined);

    await expect(
      resolvePiModelConfig({
        cwd,
        pi: { agentDir, projectDir },
        env: { LOCAL_MODEL_KEY: 'local-key' },
      }),
    ).resolves.toMatchObject({
      provider: 'local',
      modelId: 'review-model',
      apiKey: 'local-key',
      model: {
        name: 'Review model',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:11434/v1',
        headers: { Authorization: 'Bearer local-key' },
      },
    });
  });
});
