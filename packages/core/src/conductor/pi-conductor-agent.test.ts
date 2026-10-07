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
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        compaction: { enabled: false, reserveTokens: 2_000 },
        sessionDir: '/tmp/must-not-be-used',
      }),
    );
    const conductor = await PiConductorAgent.resume('session-392', {
      cwd,
      pi: { agentDir, projectDir },
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
    const settingsManager = mockCreateAgentSession.mock.calls[0]![0].settingsManager;
    expect(settingsManager.getCompactionSettings({
      provider: 'anthropic',
      id: 'model-1',
    })).toMatchObject({ enabled: false, reserveTokens: 2_000 });
    expect(settingsManager.getSettings()).not.toHaveProperty('sessionDir');
    await conductor.close();
  });

  it('applies merged ensemble compaction settings without overriding the harness session directory', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    const piProjectDir = join(cwd, '.pi');
    await mkdir(projectDir, { recursive: true });
    await mkdir(piProjectDir, { recursive: true });
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'model-1',
        compaction: {
          enabled: false,
          reserveTokens: 1_000,
          modelOverrides: {
            'anthropic/model-1': { keepRecentTokens: 2_000 },
          },
        },
        defaultThinkingLevel: 'high',
        retry: { enabled: false },
      }),
    );
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        compaction: {
          reserveTokens: 3_000,
          modelOverrides: {
            'anthropic/model-1': { keepRecentTokens: 4_000 },
          },
          unsupportedNestedKey: 'must-not-reach-pi',
        },
        branchSummary: { reserveTokens: 5_000, skipPrompt: true },
        sessionDir: '/tmp/ignored-by-conductor',
        retry: { enabled: false },
      }),
    );
    await writeFile(
      join(piProjectDir, 'settings.json'),
      JSON.stringify({
        defaultThinkingLevel: 'low',
        retry: { enabled: true },
        sessionDir: '/tmp/project-pi-leak',
        compaction: { reserveTokens: 99_999 },
        branchSummary: { reserveTokens: 88_888, skipPrompt: false },
      }),
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    const settingsManager = sessionOptions.settingsManager;
    expect(settingsManager.getCompactionSettings({
      provider: 'anthropic',
      id: 'model-1',
    })).toEqual({
      enabled: false,
      reserveTokens: 3_000,
      keepRecentTokens: 4_000,
    });
    expect(settingsManager.getBranchSummarySettings()).toEqual({
      reserveTokens: 5_000,
      skipPrompt: true,
    });
    expect(settingsManager.getGlobalSettings()).toEqual({});
    expect(settingsManager.getProjectSettings()).toEqual({});
    expect(settingsManager.getSettings()).toEqual({
      compaction: {
        enabled: false,
        reserveTokens: 3_000,
        modelOverrides: {
          'anthropic/model-1': { keepRecentTokens: 4_000 },
        },
      },
      branchSummary: { reserveTokens: 5_000, skipPrompt: true },
    });
    expect(settingsManager.getSettings()).not.toHaveProperty('sessionDir');
    expect(mockSessionManagerCreate).toHaveBeenCalledWith(
      cwd,
      join(cwd, '.ensemble/pi/sessions'),
      expect.objectContaining({ id: expect.any(String) }),
    );

    await conductor.close();
  });

  it('reapplies the startup settings snapshot after the Pi session reloads settings', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        compaction: { enabled: false, reserveTokens: 2_500 },
        branchSummary: { reserveTokens: 3_500, skipPrompt: true },
      }),
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const settingsManager = mockCreateAgentSession.mock.calls[0]![0].settingsManager;
    const applyOverrides = vi.spyOn(settingsManager, 'applyOverrides');
    fakeSession.reload.mockImplementation(async () => {
      await settingsManager.reload();
    });

    await conductor.reload();

    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: false, reserveTokens: 2_500 },
      branchSummary: { reserveTokens: 3_500, skipPrompt: true },
    });
    expect(settingsManager.getCompactionSettings({
      provider: 'anthropic',
      id: 'model-1',
    })).toMatchObject({ enabled: false, reserveTokens: 2_500 });
    expect(settingsManager.getBranchSummarySettings()).toEqual({
      reserveTokens: 3_500,
      skipPrompt: true,
    });

    await conductor.close();
  });

  it('restores the snapshot and closes the session when Pi reload fails', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        compaction: { enabled: false, reserveTokens: 2_500 },
        branchSummary: { reserveTokens: 3_500, skipPrompt: true },
      }),
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const settingsManager = mockCreateAgentSession.mock.calls[0]![0].settingsManager;
    fakeSession.reload.mockImplementation(async () => {
      await settingsManager.reload();
      throw new Error('resource reload failed');
    });

    await expect(conductor.reload()).rejects.toThrow('resource reload failed');
    expect(settingsManager.getCompactionSettings({
      provider: 'anthropic',
      id: 'model-1',
    })).toMatchObject({ enabled: false, reserveTokens: 2_500 });
    expect(settingsManager.getBranchSummarySettings()).toEqual({
      reserveTokens: 3_500,
      skipPrompt: true,
    });
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
    await expect(conductor.send('must not reuse failed reload')).resolves.toMatchObject({
      status: 'error',
      error: { message: 'Pi conductor agent is closed.' },
    });

    await conductor.close();
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
  });

  it('reports the reload and cleanup errors together as AggregateError', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        compaction: { enabled: false, reserveTokens: 2_500 },
        branchSummary: { reserveTokens: 3_500, skipPrompt: true },
      }),
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const settingsManager = mockCreateAgentSession.mock.calls[0]![0].settingsManager;
    const reloadError = new Error('resource reload failed');
    const cleanupError = new Error('session cleanup failed');
    fakeSession.reload.mockImplementation(async () => {
      await settingsManager.reload();
      throw reloadError;
    });
    fakeSession.dispose.mockImplementation(() => {
      throw cleanupError;
    });

    const error = await conductor.reload().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([reloadError, cleanupError]),
    );
    expect(settingsManager.getCompactionSettings({
      provider: 'anthropic',
      id: 'model-1',
    })).toMatchObject({ enabled: false, reserveTokens: 2_500 });
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
    await expect(conductor.send('must not reuse failed reload')).resolves.toMatchObject({
      status: 'error',
      error: { message: 'Pi conductor agent is closed.' },
    });
    await expect(conductor.close()).rejects.toBe(cleanupError);
  });

  it('closes the session and returns a snapshot restore error', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        compaction: { enabled: false, reserveTokens: 2_500 },
        branchSummary: { reserveTokens: 3_500, skipPrompt: true },
      }),
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const settingsManager = mockCreateAgentSession.mock.calls[0]![0].settingsManager;
    const restoreError = new Error('snapshot restore failed');
    const applyOverrides = vi.spyOn(settingsManager, 'applyOverrides').mockImplementation(() => {
      throw restoreError;
    });
    fakeSession.reload.mockImplementation(async () => {
      await settingsManager.reload();
    });

    await expect(conductor.reload()).rejects.toBe(restoreError);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: false, reserveTokens: 2_500 },
      branchSummary: { reserveTokens: 3_500, skipPrompt: true },
    });
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
    await expect(conductor.send('must not reuse failed snapshot restore')).resolves.toMatchObject({
      status: 'error',
      error: { message: 'Pi conductor agent is closed.' },
    });
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
            apiKey: '${LOCAL_MODEL_KEY}',
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

    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: '!printf conductor-command-key',
            authHeader: true,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );

    await expect(
      resolvePiModelConfig({
        cwd,
        pi: { agentDir, projectDir },
        env: {},
      }),
    ).resolves.toMatchObject({
      provider: 'local',
      modelId: 'review-model',
      apiKey: 'conductor-command-key',
      model: {
        headers: { Authorization: 'Bearer conductor-command-key' },
      },
    });
  });

  it('passes a custom models.json !command credential through create into a Pi request', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: '!printf command-key',
            authHeader: true,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );
    mockGetModel.mockReturnValue(undefined);

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'local/review-model',
      systemPrompt: 'system',
    });
    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    let requestAuth: unknown;
    fakeSession.prompt.mockImplementation(async () => {
      requestAuth = await sessionOptions.modelRuntime.getAuth(sessionOptions.model);
    });

    await expect(conductor.send('request')).resolves.toMatchObject({
      status: 'finished',
      modelId: 'review-model',
    });
    expect(sessionOptions.model).toMatchObject({
      provider: 'local',
      id: 'review-model',
      headers: { Authorization: 'Bearer command-key' },
    });
    expect(requestAuth).toMatchObject({
      auth: {
        apiKey: 'command-key',
        headers: { Authorization: 'Bearer command-key' },
      },
    });
    await conductor.close();
  });

  it('reports a failed custom models.json !command through create', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: "!sh -c 'exit 7'",
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );
    mockGetModel.mockReturnValue(undefined);

    await expect(
      PiConductorAgent.create({
        cwd,
        pi: { agentDir, projectDir },
        modelId: 'local/review-model',
        systemPrompt: 'system',
      }),
    ).rejects.toThrow(/Failed to resolve API key for Pi provider "local" from shell command/);
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('passes project !command auth over the user credential through create into a Pi request', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ local: { type: 'api_key', key: 'user-key' } }),
    );
    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({
        local: { type: 'api_key', key: '!printf project-command-key' },
      }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            authHeader: true,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );
    mockGetModel.mockReturnValue(undefined);

    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'local/review-model',
      systemPrompt: 'system',
    });
    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    let requestAuth: unknown;
    fakeSession.prompt.mockImplementation(async () => {
      requestAuth = await sessionOptions.modelRuntime.getAuth(sessionOptions.model);
    });

    await expect(conductor.send('request')).resolves.toMatchObject({
      status: 'finished',
      modelId: 'review-model',
    });
    expect(sessionOptions.model).toMatchObject({
      provider: 'local',
      id: 'review-model',
      headers: { Authorization: 'Bearer project-command-key' },
    });
    expect(requestAuth).toMatchObject({
      auth: {
        apiKey: 'project-command-key',
        headers: { Authorization: 'Bearer project-command-key' },
      },
    });
    expect(requestAuth).not.toMatchObject({ auth: { apiKey: 'user-key' } });
    await conductor.close();
  });
});
