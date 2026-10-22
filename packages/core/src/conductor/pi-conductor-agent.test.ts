import { existsSync } from 'node:fs';
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
    const onContextCompaction = vi.fn();
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'compiled system prompt',
      mcpServers,
      onContextCompaction,
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
    expect(sessionOptions).not.toHaveProperty('noTools');
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
      sessionListener?.({
        type: 'compaction_end',
        reason: 'threshold',
        result: {
          summary: 'compacted',
          firstKeptEntryId: 'entry-1',
          tokensBefore: 100,
          estimatedTokensAfter: 50,
          usage: {},
          details: '',
        },
        aborted: false,
        willRetry: false,
      });
      sessionListener?.({
        type: 'entry_appended',
        entry: { type: 'branch_summary' },
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
    expect(onContextCompaction).toHaveBeenCalledOnce();
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
    // Pi's usage.cost is calculated from configured token rates, not billing data.
    expect(await conductor.getUsage()).toEqual({});
    await conductor.close();
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
    expect(fakeSession.reload).toHaveBeenCalledOnce();
    void onStreamText;
  });

  it('sums usage from every assistant message in one send', async () => {
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const firstMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      model: 'model-1',
      stopReason: 'toolUse',
      usage: {
        input: 11,
        output: 5,
        totalTokens: 16,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { total: 0.1 },
      },
    };
    const finalMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'complete' }],
      model: 'model-1',
      stopReason: 'stop',
      usage: {
        input: 13,
        output: 7,
        totalTokens: 20,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { total: 0.2 },
      },
    };
    fakeSession.prompt.mockImplementation(async () => {
      fakeSession.state.messages = [firstMessage, finalMessage];
      sessionListener?.({
        type: 'agent_end',
        messages: [firstMessage, finalMessage],
        willRetry: false,
      });
    });

    const result = await conductor.send('kickoff');

    expect(result).toMatchObject({
      status: 'finished',
      result: 'complete',
      modelId: 'model-1',
      usage: {
        inputTokens: 24,
        outputTokens: 12,
        totalTokens: 36,
        cacheReadTokens: 5,
        cacheWriteTokens: 5,
      },
    });
    await conductor.close();
  });

  it('counts only successful compaction_end events and ignores missing, failed, or aborted results', async () => {
    const onContextCompaction = vi.fn();
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      onContextCompaction,
    });

    // Persisted compaction entries are not the normal success notification.
    sessionListener?.({
      type: 'entry_appended',
      entry: { type: 'compaction' },
    });
    // No event means there is nothing to count.
    expect(onContextCompaction).not.toHaveBeenCalled();

    sessionListener?.({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'Auto-compaction failed',
    });
    sessionListener?.({
      type: 'compaction_end',
      reason: 'manual',
      result: undefined,
      aborted: true,
      willRetry: false,
    });
    expect(onContextCompaction).not.toHaveBeenCalled();

    sessionListener?.({
      type: 'compaction_end',
      reason: 'overflow',
      result: {
        summary: 'compacted',
        firstKeptEntryId: 'entry-2',
        tokensBefore: 200,
        estimatedTokensAfter: 80,
        usage: {},
        details: '',
      },
      aborted: false,
      willRetry: true,
    });
    expect(onContextCompaction).toHaveBeenCalledOnce();
    await conductor.close();
  });

  it('aborts an active session prompt when cancel is requested', async () => {
    let resolvePrompt!: () => void;
    fakeSession.prompt.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      }),
    );
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });
    const sendPromise = conductor.send('working');

    await vi.waitFor(() => expect(fakeSession.prompt).toHaveBeenCalledOnce());
    await conductor.cancel();
    expect(fakeSession.abort).toHaveBeenCalledOnce();

    const finalMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      model: 'model-1',
      stopReason: 'aborted',
      usage: {
        input: 1,
        output: 1,
        totalTokens: 2,
        cost: { total: 0.1 },
      },
    };
    fakeSession.state.messages = [finalMessage];
    sessionListener?.({ type: 'agent_end', messages: [finalMessage] });
    resolvePrompt();

    await expect(sendPromise).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('closes MCP during session shutdown without launching replacement servers', async () => {
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: 'fixture-mcp',
        },
      },
    });

    expect(mcpLoadConfig?.().servers).toHaveLength(1);
    await Promise.all([conductor.close(), conductor.close()]);

    expect(fakeSession.reload).toHaveBeenCalledOnce();
    expect(mcpLoadConfig?.().servers).toEqual([]);
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
  });

  it('disables Pi built-in tools only when builtinTools is false', async () => {
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      builtinTools: false,
    });

    expect(mockCreateAgentSession.mock.calls[0]![0].noTools).toBe('builtin');
    await conductor.close();
  });

  it('does not discover, import, or register configured extensions when disabled', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    const extensionsDir = join(projectDir, 'extensions');
    const configuredImportMarker = join(cwd, 'configured-extension-imported');
    const configuredFactoryMarker = join(cwd, 'configured-extension-factory-called');
    const discoveredImportMarker = join(cwd, 'discovered-extension-imported');
    const discoveredFactoryMarker = join(cwd, 'discovered-extension-factory-called');
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'model-1',
        extensions: ['./configured-extension.mjs'],
      }),
    );

    const extensionSource = (importMarker: string, factoryMarker: string) =>
      [
        "import { writeFile } from 'node:fs/promises';",
        `await writeFile(${JSON.stringify(importMarker)}, 'imported');`,
        'export default async (pi) => {',
        `  await writeFile(${JSON.stringify(factoryMarker)}, 'called');`,
        '  pi.registerTool({',
        "    name: 'project_extension_tool',",
        "    description: 'Configured project extension tool',",
        "    parameters: { type: 'object', properties: {} },",
        "    execute: async () => ({ content: [{ type: 'text', text: 'extension' }] }),",
        '  });',
        '};',
      ].join('\n');
    await writeFile(
      join(projectDir, 'configured-extension.mjs'),
      extensionSource(configuredImportMarker, configuredFactoryMarker),
    );
    await writeFile(
      join(extensionsDir, 'discovered-extension.mjs'),
      extensionSource(discoveredImportMarker, discoveredFactoryMarker),
    );

    const operator = await PiConductorAgent.create({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'operator system',
      builtinTools: false,
      piExtensions: false,
      customTools: {
        list_operator_sessions: {
          name: 'list_operator_sessions',
          description: 'Read saved session summaries',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({
            content: [{ type: 'text' as const, text: 'sessions' }],
          }),
        },
      },
    });

    try {
      const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
      expect(sessionOptions.model).toMatchObject({
        provider: 'anthropic',
        id: 'model-1',
      });
      expect(
        sessionOptions.customTools?.map((tool: { name: string }) => tool.name),
      ).toEqual(['list_operator_sessions']);
      expect(existsSync(configuredImportMarker)).toBe(false);
      expect(existsSync(configuredFactoryMarker)).toBe(false);
      expect(existsSync(discoveredImportMarker)).toBe(false);
      expect(existsSync(discoveredFactoryMarker)).toBe(false);
    } finally {
      await operator.close();
    }
  });

  it('shuts down Pi MCP children when closing a resumable session', async () => {
    const conductor = await PiConductorAgent.create({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      mcpServers: {
        fixture: { type: 'stdio', command: 'fixture-mcp' },
      },
    });

    expect(mcpLoadConfig?.()).toMatchObject({
      servers: [expect.objectContaining({ name: 'fixture' })],
    });

    await conductor.closeForResume();

    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.reload).toHaveBeenCalledOnce();
    expect(mcpLoadConfig?.()).toMatchObject({ servers: [] });
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
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
