import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsError } from '@earendil-works/pi-ai/models';

const {
  mockCreateAgentSession,
  mockCreateMcpExtension,
  mockCreateCodemodeExtension,
  mockCreateToolSearchExtension,
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
  mockCreateCodemodeExtension: vi.fn(() => () => {}),
  mockCreateToolSearchExtension: vi.fn(() => () => {}),
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
    createCodemodeExtension: mockCreateCodemodeExtension,
    createToolSearchExtension: mockCreateToolSearchExtension,
    SessionManager: {
      ...actual.SessionManager,
      create: mockSessionManagerCreate,
      findById: mockSessionManagerFindById,
      open: mockSessionManagerOpen,
    },
  };
});

import {
  createPiConductorAgentFactory,
  PiConductorAgent,
  resolvePiModelConfig,
} from './pi-conductor-agent.js';
import { resolvePiConductorApiKey } from './conductor-pi-auth.js';
import { loadPiResources } from './pi-resource-loader.js';
import { isConductorAgentFactoryCleanupIncomplete } from './conductor-agent-factory-cleanup.js';
import { runConductorSession } from './conductor-session.js';
import { SessionLogger } from './session/session-logger.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import { computeResumeFeasibilityConfigDigest } from '../config/ensemble-config-digest.js';
import { computeMcpConfigDigest } from '../mcp/load-mcp-config.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import {
  loadSessionResumeStore,
  saveSessionResumeStore,
  SESSION_RESUME_STORE_VERSION,
} from '../session/session-resume-store.js';
import * as piResourceLoaderModule from './pi-resource-loader.js';
import * as issueContextModule from '../github/issue-context.js';
import * as resolveGitHubAuthTokenModule from '../github/resolve-github-auth-token.js';
import { sendConductorWithReconnect } from './conductor-send-reconnect.js';

const PI_TEST_ISSUE_URL = 'https://github.com/org/repo/issues/1';

function createPiAgent(
  options: Parameters<typeof PiConductorAgent.create>[0],
) {
  return PiConductorAgent.create({
    ...options,
    issueUrl: options.issueUrl ?? PI_TEST_ISSUE_URL,
  });
}

function resumePiAgent(
  agentId: string,
  options: Parameters<typeof PiConductorAgent.resume>[1],
) {
  return PiConductorAgent.resume(agentId, {
    ...options,
    issueUrl: options.issueUrl ?? PI_TEST_ISSUE_URL,
  });
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('PiConductorAgent', () => {
  let cwd = '';
  let agentDir = '';
  let fakeSession: any;
  let fakeSessionManager: any;
  let sessionListener: ((event: any) => void) | undefined;
  let mcpLoadConfig: (() => any) | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'pi-conductor-project-'));
    vi.stubEnv('HOME', cwd);
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
    fakeSessionManager = {
      getBranch: vi.fn(() => []),
      appendCustomEntry: vi.fn(),
    };
    fakeSession.sessionManager = fakeSessionManager;
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
    mcpLoadConfig = undefined;
    mockCreateMcpExtension.mockReset();
    mockCreateMcpExtension.mockImplementation((options: { loadConfig: () => unknown }) => {
      mcpLoadConfig = options.loadConfig;
      return () => {};
    });
    mockCreateCodemodeExtension.mockClear();
    mockCreateToolSearchExtension.mockClear();
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
    vi.unstubAllEnvs();
  });

  it('reports the selected model when a prompt fails before a response', async () => {
    fakeSession.prompt.mockRejectedValueOnce(new Error('fixture failure'));
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    await expect(conductor.send('kickoff')).resolves.toMatchObject({
      status: 'error',
      error: { message: 'fixture failure' },
      modelId: 'model-1',
    });
    await conductor.close();
  });

  it('redacts Pi command resolution details from ModelsError send results', async () => {
    const sentinels = {
      command: 'AGENT_COMMAND_SENTINEL_683',
      cause: 'AGENT_CAUSE_SENTINEL_683',
      nestedCause: 'AGENT_NESTED_CAUSE_SENTINEL_683',
      credential: 'AGENT_CREDENTIAL_SENTINEL_683',
      stdout: 'AGENT_STDOUT_SENTINEL_683',
      stderr: 'AGENT_STDERR_SENTINEL_683',
    };
    const rawCause = Object.assign(
      new Error(
        `Failed to resolve API key for provider "litellm" from shell command: ${sentinels.command}`,
        { cause: new Error(sentinels.nestedCause) },
      ),
      {
        rawCause: sentinels.cause,
        credential: sentinels.credential,
        stdout: Buffer.from(sentinels.stdout),
        stderr: Buffer.from(sentinels.stderr),
      },
    );
    fakeSession.prompt.mockRejectedValueOnce(
      new ModelsError(
        'auth',
        'API key auth failed for provider litellm',
        { cause: rawCause },
      ),
    );
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const result = await conductor.send('kickoff');
    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'auth',
        message:
          'API key auth failed for provider: failed to resolve API key for Pi provider from the configured command.',
      },
      modelId: 'model-1',
    });
    const output = JSON.stringify(result);
    for (const sentinel of Object.values(sentinels)) {
      expect(output).not.toContain(sentinel);
    }
    await conductor.close();
  });

  it.each(['create', 'resume'] as const)(
    'uses the Pi settings default model when %s receives the backend default',
    async (operation) => {
      if (operation === 'resume') {
        mockSessionManagerFindById.mockReturnValue('/tmp/pi-default-session.jsonl');
      }
      const options = {
        cwd,
        pi: { agentDir },
        modelId: 'default',
        systemPrompt: 'system',
      };
      const conductor =
        operation === 'create'
          ? await createPiAgent(options)
          : await resumePiAgent('pi-default-session', options);

      expect(mockCreateAgentSession.mock.calls[0]?.[0].model).toMatchObject({
        provider: 'anthropic',
        id: 'model-1',
      });
      await conductor.close();
    },
  );

  it('creates a Pi 1.x AgentSession and injects the resolved MCP map into the official extension', async () => {
    const mcpServers = {
      representative: {
        type: 'stdio' as const,
        command: 'fixture-mcp',
        args: ['--shared'],
      },
    };
    const onContextCompaction = vi.fn();
    const conductor = await createPiAgent({
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
    expect(sessionOptions).not.toHaveProperty('thinkingLevel');
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
    expect(mockCreateCodemodeExtension).toHaveBeenCalledOnce();
    expect(mockCreateToolSearchExtension).toHaveBeenCalledOnce();

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
        message: finalMessage,
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

  it('sums usage across agent_end events and resets it between sends', async () => {
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    const firstMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      model: 'intermediate-model',
      stopReason: 'error',
      errorMessage: 'temporary failure',
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
      model: 'final-model',
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
    const toolResult = {
      role: 'toolResult',
      usage: {
        input: 100,
        output: 100,
        totalTokens: 200,
        cacheRead: 100,
        cacheWrite: 100,
        cost: { total: 10 },
      },
    };
    const nextSendMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'next send' }],
      model: 'next-model',
      stopReason: 'stop',
      usage: {
        input: 3,
        output: 2,
        totalTokens: 5,
        cacheRead: 1,
        cacheWrite: 2,
        cost: { total: 0.05 },
      },
    };
    let sendCount = 0;
    fakeSession.prompt.mockImplementation(async () => {
      if (sendCount++ === 0) {
        fakeSession.state.messages = [firstMessage, toolResult, finalMessage];
        sessionListener?.({
          type: 'agent_end',
          messages: [firstMessage, toolResult],
          willRetry: true,
        });
        sessionListener?.({
          type: 'agent_end',
          messages: [finalMessage],
          willRetry: false,
        });
      } else {
        fakeSession.state.messages = [
          firstMessage,
          toolResult,
          finalMessage,
          nextSendMessage,
        ];
        sessionListener?.({
          type: 'agent_end',
          messages: [nextSendMessage],
          willRetry: false,
        });
      }
    });

    const result = await conductor.send('kickoff');

    expect(result).toMatchObject({
      status: 'finished',
      result: 'complete',
      modelId: 'final-model',
      usage: {
        inputTokens: 24,
        outputTokens: 12,
        totalTokens: 36,
        cacheReadTokens: 5,
        cacheWriteTokens: 5,
      },
    });

    const nextResult = await conductor.send('next');
    expect(nextResult).toMatchObject({
      status: 'finished',
      result: 'next send',
      modelId: 'next-model',
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      },
    });
    await conductor.close();
  });

  it('records only successful non-bootstrap final responses as ID-only custom metadata', async () => {
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });
    const branchEntry = (id: string, role: 'user' | 'assistant', text: string) => ({
      type: 'message',
      id,
      message: {
        role,
        content: [
          ...(role === 'assistant'
            ? [
                { type: 'thinking', thinking: 'THINKING_SECRET' },
                {
                  type: 'toolCall',
                  id: 'tool-1',
                  name: 'shell',
                  arguments: { command: 'TOOL_SECRET' },
                },
              ]
            : []),
          { type: 'text', text },
        ],
      },
    });
    const inbound = branchEntry('user-entry', 'user', 'formatted inbound');
    const response = branchEntry('assistant-entry', 'assistant', 'final answer');
    fakeSessionManager.getBranch.mockReturnValue([inbound, response]);
    fakeSession.prompt.mockImplementation(async () => {
      const finalMessage = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'THINKING_SECRET' },
          {
            type: 'toolCall',
            id: 'tool-1',
            name: 'shell',
            arguments: { command: 'TOOL_SECRET' },
          },
          { type: 'text', text: 'final answer' },
        ],
        model: 'model-1',
        stopReason: 'stop',
        usage: { input: 1, output: 1, totalTokens: 2 },
      };
      fakeSession.state.messages = [finalMessage];
      sessionListener?.({ type: 'agent_end', messages: [finalMessage] });
    });

    const result = await conductor.send('formatted inbound', {
      history: { sendCount: 9, dispatchSource: 'worker:reviewer' },
    });
    expect(result).toMatchObject({ status: 'finished', result: 'final answer' });
    expect(fakeSessionManager.appendCustomEntry).toHaveBeenCalledOnce();
    expect(fakeSessionManager.appendCustomEntry).toHaveBeenCalledWith(
      'agents-ensemble/conductor-message-history/v1',
      {
        inboundEntryId: 'user-entry',
        responseEntryId: 'assistant-entry',
        completedAt: expect.any(Number),
        sendCount: 9,
        dispatchSource: 'worker:reviewer',
      },
    );
    const metadata = JSON.stringify(
      fakeSessionManager.appendCustomEntry.mock.calls[0],
    );
    expect(metadata).not.toContain('formatted inbound');
    expect(metadata).not.toContain('final answer');
    expect(metadata).not.toContain('TOOL_SECRET');
    expect(metadata).not.toContain('THINKING_SECRET');
    await conductor.close();
  });

  it('does not persist an in-progress send before its final response arrives', async () => {
    let finishPrompt!: () => void;
    fakeSession.prompt.mockReturnValue(
      new Promise<void>((resolve) => {
        finishPrompt = resolve;
      }),
    );
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });
    const send = conductor.send('in progress', {
      history: { sendCount: 2, dispatchSource: 'operator' },
    });

    await vi.waitFor(() => expect(fakeSession.prompt).toHaveBeenCalledOnce());
    expect(fakeSessionManager.appendCustomEntry).not.toHaveBeenCalled();

    const finalMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'finished answer' }],
      model: 'model-1',
      stopReason: 'stop',
      usage: { input: 1, output: 1, totalTokens: 2 },
    };
    fakeSessionManager.getBranch.mockReturnValue([
      {
        type: 'message',
        id: 'in-progress-user',
        message: { role: 'user', content: 'in progress' },
      },
      {
        type: 'message',
        id: 'in-progress-response',
        message: { role: 'assistant', content: 'finished answer' },
      },
    ]);
    fakeSession.state.messages = [finalMessage];
    sessionListener?.({ type: 'agent_end', messages: [finalMessage] });
    finishPrompt();

    await expect(send).resolves.toMatchObject({
      status: 'finished',
      result: 'finished answer',
    });
    expect(fakeSessionManager.appendCustomEntry).toHaveBeenCalledOnce();
    await conductor.close();
  });

  it.each([
    ['failed', 'error', 'partial response'],
    ['cancelled', 'aborted', 'partial response'],
    ['empty', 'stop', ''],
    ['bootstrap', 'stop', 'bootstrap response'],
  ] as const)(
    'does not persist %s responses in the durable list',
    async (caseName, stopReason, responseText) => {
      const conductor = await createPiAgent({
        cwd,
        pi: { agentDir },
        modelId: 'anthropic/model-1',
        systemPrompt: 'system',
      });
      fakeSessionManager.appendCustomEntry.mockClear();
      fakeSession.prompt.mockImplementation(async () => {
        const finalMessage = {
          role: 'assistant',
          content: responseText
            ? [{ type: 'text', text: responseText }]
            : [],
          model: 'model-1',
          stopReason,
          usage: { input: 1, output: 1, totalTokens: 2 },
        };
        fakeSession.state.messages = [finalMessage];
        sessionListener?.({ type: 'agent_end', messages: [finalMessage] });
      });

      await conductor.send('prompt', {
        history: {
          sendCount: 1,
          dispatchSource: caseName === 'bootstrap' ? 'initial' : 'operator',
        },
      });

      expect(fakeSessionManager.appendCustomEntry).not.toHaveBeenCalled();
      await conductor.close();
    },
  );

  it('counts only successful compaction_end events and ignores missing, failed, or aborted results', async () => {
    const onContextCompaction = vi.fn();
    const conductor = await createPiAgent({
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
    const conductor = await createPiAgent({
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
    const conductor = await createPiAgent({
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
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      builtinTools: false,
    });

    expect(mockCreateAgentSession.mock.calls[0]![0].noTools).toBe('builtin');
    await conductor.close();
  });

  it('registers the existing internal Pi extensions by default', async () => {
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    expect(mockCreateMcpExtension).toHaveBeenCalledOnce();
    expect(mockCreateCodemodeExtension).toHaveBeenCalledOnce();
    expect(mockCreateToolSearchExtension).toHaveBeenCalledOnce();
    await conductor.close();
  });

  it.each(['create', 'resume'] as const)(
    'uses direct MCP and omits Codemode for operator Pi %s',
    async (operation) => {
      if (operation === 'resume') {
        mockSessionManagerFindById.mockReturnValue(
          '/tmp/operator-direct-session.jsonl',
        );
      }
      const options = {
        cwd,
        pi: { agentDir },
        modelId: 'anthropic/model-1',
        systemPrompt: 'operator system',
        builtinTools: false,
        piExtensions: false,
        operatorPiMcpMode: 'direct' as const,
        mcpServers: {
          selected: { type: 'stdio' as const, command: 'selected-mcp' },
          'selected-http': {
            type: 'http' as const,
            url: 'https://mcp.example.test/mcp',
            headers: { Authorization: 'Bearer token' },
          },
        },
        customTools: {
          read_operator_workspace_file: {
            name: 'read_operator_workspace_file',
            description: 'Read an operator workspace file',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => ({
              content: [{ type: 'text' as const, text: 'workspace file' }],
            }),
          },
        },
      };
      const loadResourcesSpy = vi.spyOn(
        piResourceLoaderModule,
        'loadPiResources',
      );
      const conductor =
        operation === 'create'
          ? await createPiAgent(options)
          : await resumePiAgent('operator-direct-session', options);

      expect(loadResourcesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ loadExtensions: false }),
      );
      expect(mockCreateMcpExtension).toHaveBeenCalledOnce();
      expect(mockCreateCodemodeExtension).not.toHaveBeenCalled();
      expect(mockCreateToolSearchExtension).toHaveBeenCalledOnce();
      expect(mcpLoadConfig?.()).toEqual({
        autoEnableCodemode: false,
        errors: [],
        servers: [
          {
            name: 'selected',
            source: '<agents-ensemble-resolved-mcp.json>',
            scope: 'project',
            config: {
              type: 'stdio',
              command: 'selected-mcp',
              exposure: 'direct',
            },
          },
          {
            name: 'selected-http',
            source: '<agents-ensemble-resolved-mcp.json>',
            scope: 'project',
            config: {
              type: 'http',
              url: 'https://mcp.example.test/mcp',
              headers: { Authorization: 'Bearer token' },
              exposure: 'direct',
            },
          },
        ],
      });
      const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
      expect(sessionOptions.noTools).toBe('builtin');
      expect(sessionOptions.customTools).toEqual([
        expect.objectContaining({ name: 'read_operator_workspace_file' }),
      ]);
      await conductor.close();
    },
  );

  it('keeps Pi prompt templates and skills enabled by default', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(join(projectDir, 'prompts'), { recursive: true });
    await mkdir(join(projectDir, 'skills', 'review'), { recursive: true });
    await writeFile(
      join(projectDir, 'prompts', 'review.md'),
      '---\ndescription: review prompt\n---\nreview template body',
    );
    await writeFile(
      join(projectDir, 'skills', 'review', 'SKILL.md'),
      '---\ndescription: review skill\n---\nreview skill body',
    );

    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'issue session system',
    });

    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    expect(sessionOptions.resourceLoader).toBeDefined();
    expect(sessionOptions.resourceLoader.getSkills().skills).toEqual([
      expect.objectContaining({
        name: 'review',
        filePath: join(projectDir, 'skills', 'review', 'SKILL.md'),
      }),
    ]);
    await conductor.send('/review');
    expect(fakeSession.prompt).toHaveBeenCalledWith('review template body', {
      expandPromptTemplates: false,
      source: 'rpc',
    });
    await conductor.close();
  });

  it('opts out of internal Pi extensions and keeps only explicitly supplied tools', async () => {
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'doctor system',
      builtinTools: false,
      piPromptResources: false,
      piSkills: false,
      piExtensions: false,
      piInternalExtensions: false,
      mcpServers: {
        ignored: {
          type: 'sse',
          url: 'https://example.invalid/mcp',
        },
      },
      customTools: {
        doctor_read_config: {
          name: 'doctor_read_config',
          description: 'Read allowlisted non-secret settings',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({
            content: [{ type: 'text' as const, text: 'settings' }],
          }),
        },
      },
    });

    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    expect(sessionOptions.noTools).toBe('builtin');
    expect(sessionOptions.resourceLoader.getSkills().skills).toEqual([]);
    expect(
      sessionOptions.customTools?.map((tool: { name: string }) => tool.name),
    ).toEqual(['doctor_read_config']);
    expect(mockCreateMcpExtension).not.toHaveBeenCalled();
    expect(mockCreateCodemodeExtension).not.toHaveBeenCalled();
    expect(mockCreateToolSearchExtension).not.toHaveBeenCalled();
    expect(mcpLoadConfig).toBeUndefined();
    await conductor.close();
  });

  it('does not load or expand Pi prompt templates or skills when explicitly disabled', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(join(projectDir, 'prompts'), { recursive: true });
    await mkdir(join(projectDir, 'skills', 'private'), { recursive: true });
    await writeFile(
      join(projectDir, 'prompts', 'private.md'),
      'doctor prompt leak sentinel',
    );
    await writeFile(
      join(projectDir, 'skills', 'private', 'SKILL.md'),
      'doctor skill leak sentinel',
    );
    const systemPrompt = 'explicit doctor role and materials';

    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      systemPrompt,
      piPromptResources: false,
      piSkills: false,
      builtinTools: false,
    });

    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    expect(sessionOptions.resourceLoader.getSkills().skills).toEqual([]);
    expect(sessionOptions.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(sessionOptions.resourceLoader.getSystemPrompt()).toContain(
      systemPrompt,
    );
    await conductor.send('/private');
    expect(fakeSession.prompt).toHaveBeenCalledWith('/private', {
      expandPromptTemplates: false,
      source: 'rpc',
    });
    await conductor.send('/skill:private');
    expect(fakeSession.prompt).toHaveBeenLastCalledWith('/skill:private', {
      expandPromptTemplates: false,
      source: 'rpc',
    });
    expect(
      JSON.stringify(sessionOptions.resourceLoader),
    ).not.toMatch(/doctor (prompt|skill) leak sentinel/);
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

    const operator = await createPiAgent({
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
    const conductor = await createPiAgent({
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

  it('keeps Pi closed and disposes the session when close rejects', async () => {
    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });
    const abortError = new Error('Pi abort cleanup failed');
    fakeSession.abort.mockRejectedValueOnce(abortError);

    await expect(conductor.close()).rejects.toBe(abortError);
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
    await expect(conductor.send('must not reuse after failed close')).resolves
      .toMatchObject({
        status: 'error',
        error: { message: 'Pi conductor agent is closed.' },
      });

    await expect(conductor.close()).rejects.toBe(abortError);
    expect(fakeSession.abort).toHaveBeenCalledOnce();
    expect(fakeSession.dispose).toHaveBeenCalledOnce();
  });

  it('rejects SSE before the Pi extension is started', async () => {
    const conductorPromise = createPiAgent({
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

  it('passes an explicitly supported reasoning level to the Pi session', async () => {
    mockGetModel.mockReturnValue({
      id: 'model-1',
      name: 'Model 1',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    });

    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      reasoning: 'high',
      systemPrompt: 'system',
    });

    expect(mockCreateAgentSession.mock.calls[0]![0].thinkingLevel).toBe('high');
    await conductor.close();
  });

  it('allows extended Pi levels only when the model maps them', async () => {
    mockGetModel.mockReturnValue({
      id: 'model-1',
      name: 'Model 1',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      reasoning: true,
      thinkingLevelMap: { max: 'high' },
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    });

    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      reasoning: 'max',
      systemPrompt: 'system',
    });

    expect(mockCreateAgentSession.mock.calls[0]![0].thinkingLevel).toBe('max');
    await conductor.close();
  });

  it('rejects an unknown Pi reasoning value before creating the transcript session', async () => {
    await expect(
      createPiAgent({
        cwd,
        pi: { agentDir },
        modelId: 'anthropic/model-1',
        reasoning: 'ultra',
        systemPrompt: 'system',
      }),
    ).rejects.toThrow(/Pi conductor reasoning "ultra" is invalid/);

    expect(mockSessionManagerCreate).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it('rejects a Pi reasoning value the selected model cannot represent', async () => {
    await expect(
      createPiAgent({
        cwd,
        pi: { agentDir },
        modelId: 'anthropic/model-1',
        reasoning: 'high',
        systemPrompt: 'system',
      }),
    ).rejects.toThrow(/does not support reasoning level "high".*Supported levels: off/);

    expect(mockSessionManagerCreate).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it.each([
    { api: 'google-generative-ai', provider: 'google' },
    { api: 'google-vertex', provider: 'google-vertex' },
  ])(
    'rejects explicit reasoning for Gemini 4 on $api before creating a transcript session',
    async ({ api, provider }) => {
      mockGetModel.mockReturnValue({
        id: 'gemini-4-argon',
        name: 'Gemini 4 Argon',
        provider,
        api,
        baseUrl: 'https://example.invalid',
        reasoning: true,
        thinkingLevelMap: { high: 'high' },
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      });

      await expect(
        createPiAgent({
          cwd,
          pi: { agentDir },
          modelId: `${provider}/gemini-4-argon`,
          reasoning: 'high',
          systemPrompt: 'system',
        }),
      ).rejects.toThrow(/cannot be applied to Google Gemini 4 model.*Pi 1\.2\.0/);

      expect(mockSessionManagerCreate).not.toHaveBeenCalled();
      expect(mockCreateAgentSession).not.toHaveBeenCalled();
    },
  );

  it('resumes from the canonical Issue slug by default with the same conductor id', async () => {
    mockSessionManagerFindById.mockReturnValue('/tmp/pi-session.jsonl');
    mockGetModel.mockReturnValue({
      id: 'model-1',
      name: 'Model 1',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    });
    const projectDir = join(cwd, '.ensemble', 'pi');
    const sessionDir = resolveEnsemblePaths({ repoRoot: cwd })
      .canonicalPiSessionsDir(PI_TEST_ISSUE_URL);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        compaction: { enabled: false, reserveTokens: 2_000 },
        sessionDir: '/tmp/must-not-be-used',
      }),
    );
    const conductor = await resumePiAgent('session-392', {
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'anthropic/model-1',
      reasoning: 'medium',
      systemPrompt: 'recompiled system prompt',
    });

    expect(mockSessionManagerFindById).toHaveBeenCalledWith(
      cwd,
      'session-392',
      sessionDir,
    );
    expect(mockSessionManagerOpen).toHaveBeenCalledWith(
      '/tmp/pi-session.jsonl',
      sessionDir,
      cwd,
    );
    expect(mockCreateAgentSession.mock.calls[0]![0].sessionStartEvent).toMatchObject({
      type: 'session_start',
      reason: 'resume',
      previousSessionFile: '/tmp/pi-session.jsonl',
    });
    expect(mockCreateAgentSession.mock.calls[0]![0].thinkingLevel).toBe('medium');
    const settingsManager = mockCreateAgentSession.mock.calls[0]![0].settingsManager;
    expect(settingsManager.getCompactionSettings({
      provider: 'anthropic',
      id: 'model-1',
    })).toMatchObject({ enabled: false, reserveTokens: 2_000 });
    expect(settingsManager.getSettings()).not.toHaveProperty('sessionDir');
    await conductor.close();
  });

  it('fails closed when Pi session identity and explicit directory are both missing', async () => {
    const paths = resolveEnsemblePaths({ repoRoot: cwd });

    await expect(
      PiConductorAgent.create({
        cwd,
        pi: { agentDir },
        modelId: 'anthropic/model-1',
        systemPrompt: 'system',
      }),
    ).rejects.toThrow(/requires issueUrl or an explicit sessionDir/);
    await expect(
      PiConductorAgent.resume('missing-identity-session', {
        cwd,
        pi: { agentDir },
        modelId: 'anthropic/model-1',
        systemPrompt: 'system',
      }),
    ).rejects.toThrow(/requires issueUrl or an explicit sessionDir/);

    expect(mockSessionManagerCreate).not.toHaveBeenCalled();
    expect(mockSessionManagerFindById).not.toHaveBeenCalled();
    expect(mockSessionManagerOpen).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
    expect(existsSync(paths.legacyHashPiSessionsDir)).toBe(false);
    expect(existsSync(join(cwd, '.ensemble', 'pi', 'sessions'))).toBe(false);
  });

  it.each(['user-path-hash', 'project-legacy'] as const)(
    'does not resume from a %s Pi transcript',
    async (location) => {
      const paths = resolveEnsemblePaths({ repoRoot: cwd });
      const slugSessionDir = paths.canonicalPiSessionsDir(PI_TEST_ISSUE_URL);
      const hashSessionDir = paths.legacyHashPiSessionsDir;
      const projectSessionDir = join(cwd, '.ensemble', 'pi', 'sessions');
      const legacySessionDir =
        location === 'user-path-hash' ? hashSessionDir : projectSessionDir;
      const legacySessionFile = join(legacySessionDir, 'legacy-session.jsonl');
      const transcript = Buffer.from(
        '{"type":"session","id":"legacy-session"}\n',
        'utf8',
      );
      await mkdir(legacySessionDir, { recursive: true });
      await writeFile(legacySessionFile, transcript);
      mockSessionManagerFindById.mockImplementation(
        (_cwd: string, _sessionId: string, sessionDir: string) =>
          sessionDir === legacySessionDir ? legacySessionFile : undefined,
      );

      await expect(
        resumePiAgent('legacy-session', {
          cwd,
          pi: { agentDir },
          modelId: 'anthropic/model-1',
          systemPrompt: 'recompiled system prompt',
        }),
      ).rejects.toThrow('Pi session not found for resume');

      expect(mockSessionManagerFindById).toHaveBeenCalledTimes(1);
      expect(mockSessionManagerFindById).toHaveBeenCalledWith(
        cwd,
        'legacy-session',
        slugSessionDir,
      );
      expect(mockSessionManagerOpen).not.toHaveBeenCalled();
      expect(await readFile(legacySessionFile)).toEqual(transcript);
      await expect(
        readFile(join(slugSessionDir, 'legacy-session.jsonl')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('finds a canonical transcript by its saved cwd and resumes it in the current cwd', async () => {
    const paths = resolveEnsemblePaths({ repoRoot: cwd });
    const sessionDir = paths.canonicalPiSessionsDir(PI_TEST_ISSUE_URL);
    const savedCwd = join(cwd, 'previous-clone', '.ensemble', 'worktrees', 'issue-1');
    const sessionFile = join(sessionDir, 'cross-clone-session.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: 'session',
        id: 'cross-clone-session',
        cwd: savedCwd,
      })}\n`,
    );
    mockSessionManagerFindById.mockImplementation(
      (candidateCwd: string, sessionId: string, candidateDir: string) =>
        candidateCwd === savedCwd &&
        sessionId === 'cross-clone-session' &&
        candidateDir === sessionDir
          ? sessionFile
          : undefined,
    );

    const conductor = await resumePiAgent('cross-clone-session', {
      cwd,
      resumeCwds: [savedCwd],
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'recompiled system prompt',
    });

    expect(mockSessionManagerFindById).toHaveBeenNthCalledWith(
      1,
      cwd,
      'cross-clone-session',
      sessionDir,
    );
    expect(mockSessionManagerFindById).toHaveBeenNthCalledWith(
      2,
      savedCwd,
      'cross-clone-session',
      sessionDir,
    );
    expect(mockSessionManagerOpen).toHaveBeenCalledWith(
      sessionFile,
      sessionDir,
      cwd,
    );
    await conductor.close();
  });

  it('keeps an existing canonical Pi transcript ahead of a different legacy copy', async () => {
    const paths = resolveEnsemblePaths({ repoRoot: cwd });
    const slugSessionDir = paths.canonicalPiSessionsDir(PI_TEST_ISSUE_URL);
    const hashSessionDir = paths.legacyHashPiSessionsDir;
    const slugFile = join(slugSessionDir, 'resume-existing.jsonl');
    const hashFile = join(hashSessionDir, 'resume-existing.jsonl');
    const slugBytes = Buffer.from('{"type":"slug-session"}\n', 'utf8');
    const hashBytes = Buffer.from('{"type":"hash-session"}\n', 'utf8');
    await mkdir(slugSessionDir, { recursive: true });
    await mkdir(hashSessionDir, { recursive: true });
    await writeFile(slugFile, slugBytes);
    await writeFile(hashFile, hashBytes);
    mockSessionManagerFindById.mockImplementation(
      (_cwd: string, _sessionId: string, sessionDir: string) =>
        sessionDir === slugSessionDir
          ? slugFile
          : sessionDir === hashSessionDir
            ? hashFile
            : undefined,
    );

    const conductor = await resumePiAgent('resume-existing', {
      cwd,
      pi: { agentDir },
      modelId: 'anthropic/model-1',
      systemPrompt: 'recompiled system prompt',
    });

    expect(mockSessionManagerFindById).toHaveBeenCalledTimes(1);
    expect(mockSessionManagerOpen).toHaveBeenCalledWith(
      slugFile,
      slugSessionDir,
      cwd,
    );
    expect(await readFile(slugFile)).toEqual(slugBytes);
    expect(await readFile(hashFile)).toEqual(hashBytes);
    await conductor.close();
  });

  it('creates in canonical Issue storage by default and applies merged compaction settings', async () => {
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

    const conductor = await createPiAgent({
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
      resolveEnsemblePaths({ repoRoot: cwd })
        .canonicalPiSessionsDir(PI_TEST_ISSUE_URL),
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

    const conductor = await createPiAgent({
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

    const conductor = await createPiAgent({
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

    const conductor = await createPiAgent({
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

  it.each([
    { mode: 'create', cleanupFails: true },
    { mode: 'resume', cleanupFails: true },
    { mode: 'resume', cleanupFails: false },
  ] as const)(
    'preserves Pi partial-startup cleanup behavior for $mode (cleanupFails=$cleanupFails)',
    async ({ mode, cleanupFails }) => {
      const issueUrl = 'https://github.com/org/repo/issues/1';
      const agentId = 'pi-startup-cleanup-incomplete';
      const projectDir = join(cwd, 'project-pi');
      const mcpServers = {
        fixture: {
          type: 'stdio' as const,
          command: 'fixture-mcp',
        },
      };
      const ensembleConfig = {
        ...DEFAULT_ENSEMBLE_CONFIG,
        conductor: {
          ...DEFAULT_ENSEMBLE_CONFIG.conductor,
          backend: 'pi' as const,
          pi: { agentDir, projectDir },
        },
      };
      const profile = {
        conductor: { backend: 'pi' as const },
        workers: [],
      };
      const resumeStorePath = resolveEnsemblePaths({ repoRoot: cwd })
        .canonicalSessionResumeStorePath(issueUrl, agentId);
      await mkdir(join(cwd, '.agents'), { recursive: true });
      await writeFile(
        join(cwd, '.agents', 'mcp.json'),
        JSON.stringify({ mcpServers }),
      );

      if (mode === 'resume') {
        await saveSessionResumeStore(resumeStorePath, {
          version: SESSION_RESUME_STORE_VERSION,
          conductorAgentId: agentId,
          conductorBackend: 'pi',
          issueUrl,
          repoRoot: cwd,
          profile,
          openQuestions: [],
          sequence: 0,
          workers: {},
          mcpConfigDigest: computeMcpConfigDigest(mcpServers),
          ensembleConfigDigestScheme: 'resume-feasibility',
          ensembleConfigDigest:
            computeResumeFeasibilityConfigDigest(ensembleConfig),
          lifecycle: 'closed',
          harnessPhase: 'close',
          updatedAt: 1,
        });
        mockSessionManagerFindById.mockReturnValue(
          join(cwd, 'previous-session.jsonl'),
        );
      }

      const startupFailure = new Error('fixture MCP extension startup failed');
      const reloadFailure = new Error('fixture Pi reload cleanup failed');
      const disposeFailure = new Error('fixture Pi dispose cleanup failed');
      fakeSession.bindExtensions.mockImplementation(
        async ({ onError }: { onError: (error: unknown) => void }) => {
          onError({
            extensionPath: 'fixture/mcp-extension',
            event: 'session_start',
            error: startupFailure.message,
          });
        },
      );
      if (cleanupFails) {
        fakeSession.reload.mockRejectedValueOnce(reloadFailure);
        fakeSession.dispose.mockImplementationOnce(() => {
          throw disposeFailure;
        });
      }

      vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
        issue: { owner: 'org', repo: 'repo', number: 1, url: issueUrl },
        title: 'Test',
        body: 'Issue body',
        state: 'OPEN',
        labels: [],
        comments: [],
      });
      vi.spyOn(resolveGitHubAuthTokenModule, 'resolveGitHubAuthToken')
        .mockResolvedValue({ token: 'test-github-token', source: 'GITHUB_TOKEN' });

      const emitted: unknown[] = [];
      const sessionLogger = new SessionLogger({ issueUrl, repoRoot: cwd });
      sessionLogger.subscribe((event) => emitted.push(event));
      const signalListenersBefore = {
        sigint: process.listeners('SIGINT'),
        sigterm: process.listeners('SIGTERM'),
      };

      const startupError = await runConductorSession({
        issueUrl,
        repoRoot: cwd,
        conductorCwd: cwd,
        ensembleConfig,
        profile,
        conductorAgentFactory: createPiConductorAgentFactory(),
        ...(mode === 'resume' ? { resumeAgentId: agentId } : {}),
        mcpConfigOptions: { userEnsembleRoot: join(cwd, 'user-ensemble') },
        permissionPipeline: new PermissionPipeline({}),
        disableGitHubMonitor: true,
        waitForOperatorExit: false,
        sessionLogger,
      }).catch((error: unknown) => error);

      if (cleanupFails) {
        expect(startupError).toBeInstanceOf(AggregateError);
        expect(isConductorAgentFactoryCleanupIncomplete(startupError)).toBe(true);
        expect((startupError as AggregateError).errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining(startupFailure.message),
            }),
            reloadFailure,
            disposeFailure,
          ]),
        );
        expect(emitted).toContainEqual(
          expect.objectContaining({
            type: 'harness.warning',
            message: expect.stringContaining(
              '起動失敗後の後始末に失敗しました',
            ),
          }),
        );
      } else {
        expect(startupError).toBeInstanceOf(Error);
        expect(startupError).not.toBeInstanceOf(AggregateError);
        expect(isConductorAgentFactoryCleanupIncomplete(startupError)).toBe(false);
        expect(startupError).toMatchObject({
          message: expect.stringContaining(startupFailure.message),
        });
      }
      expect(mockCreateAgentSession).toHaveBeenCalledOnce();
      expect(fakeSession.reload).toHaveBeenCalledOnce();
      expect(fakeSession.dispose).toHaveBeenCalledOnce();
      if (mode === 'resume') {
        if (cleanupFails) {
          expect(emitted).toContainEqual(
            expect.objectContaining({
              type: 'harness.warning',
              message: expect.stringContaining(
                '再開記録を unknown/running のまま保ちます',
              ),
            }),
          );
        }
      }
      expect(process.listeners('SIGINT')).toEqual(signalListenersBefore.sigint);
      expect(process.listeners('SIGTERM')).toEqual(signalListenersBefore.sigterm);

      if (mode === 'resume') {
        await expect(loadSessionResumeStore(resumeStorePath)).resolves.toMatchObject({
          lifecycle: cleanupFails ? 'unknown' : 'closed',
          harnessPhase: cleanupFails ? 'running' : 'close',
          ensembleConfigDigestScheme: 'resume-feasibility',
          ensembleConfigDigest:
            computeResumeFeasibilityConfigDigest(ensembleConfig),
        });
      }
    },
  );

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

    const conductor = await createPiAgent({
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

    const markerPath = join(cwd, 'models-command-ran');
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: `!printf conductor-command-key; touch ${markerPath}`,
            authHeader: true,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );

    const commandModelConfig = await resolvePiModelConfig({
      cwd,
      pi: { agentDir, projectDir },
      env: {},
    });
    expect(commandModelConfig).toMatchObject({
      provider: 'local',
      modelId: 'review-model',
      model: {
        headers: {},
      },
    });
    expect(commandModelConfig).not.toHaveProperty('apiKey');
    expect(existsSync(markerPath)).toBe(false);
  });

  it('defers a custom models.json !command credential until request auth resolution', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    const markerPath = join(cwd, 'models-command-ran');
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: `!printf command-key; touch ${markerPath}`,
            authHeader: true,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );
    mockGetModel.mockReturnValue(undefined);

    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'local/review-model',
      systemPrompt: 'system',
    });
    expect(existsSync(markerPath)).toBe(false);

    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    let requestAuth: unknown;
    fakeSession.prompt.mockImplementation(async () => {
      const resources = await loadPiResources({
        cwd,
        pi: { agentDir, projectDir },
      });
      requestAuth = await resolvePiConductorApiKey({
        modelRuntime: sessionOptions.modelRuntime,
        resources,
        provider: 'local',
      });
    });

    await expect(conductor.send('request')).resolves.toMatchObject({
      status: 'finished',
      modelId: 'review-model',
    });
    expect(requestAuth).toBe('command-key');
    expect(existsSync(markerPath)).toBe(true);
    await conductor.close();
  });

  it('resumes after a Pi !command credential 401 without preflighting at startup or replaying the prompt', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    const keyFile = join(cwd, 'dynamic-key.txt');
    const markerPath = join(cwd, 'dynamic-command-ran');
    await writeFile(keyFile, 'expired-key');
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: `!cat ${keyFile}; touch ${markerPath}`,
            authHeader: true,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );
    mockGetModel.mockReturnValue(undefined);
    mockSessionManagerFindById.mockReturnValue('/tmp/pi-dynamic-auth.jsonl');

    const prompts: string[] = [];
    fakeSession.prompt.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      const sessionOptions = mockCreateAgentSession.mock.calls.at(-1)![0];
      const resources = await loadPiResources({
        cwd,
        pi: { agentDir, projectDir },
      });
      const apiKey = await resolvePiConductorApiKey({
        modelRuntime: sessionOptions.modelRuntime,
        resources,
        provider: 'local',
      });
      sessionOptions.model.headers.Authorization = `Bearer ${apiKey}`;
      const authorization = sessionOptions.model.headers.Authorization;
      if (authorization === 'Bearer expired-key') {
        await writeFile(keyFile, 'fresh-key');
        throw new Error(
          'litellm API error (401): Your client does not have permission',
        );
      }

      expect(authorization).toBe('Bearer fresh-key');
      const finalMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Recovered with fresh auth.' }],
        model: 'review-model',
        stopReason: 'stop',
        usage: {
          input: 1,
          output: 1,
          totalTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0 },
        },
      };
      fakeSession.state.messages = [finalMessage];
      sessionListener?.({
        type: 'agent_end',
        messages: [finalMessage],
        willRetry: false,
      });
    });

    const factory = createPiConductorAgentFactory();
    const conductorOptions = {
      cwd,
      issueUrl: PI_TEST_ISSUE_URL,
      pi: { agentDir, projectDir },
      modelId: 'local/review-model',
      systemPrompt: 'operator auth regression',
    };
    const handle = {
      conductor: await factory.create(conductorOptions),
    };
    expect(existsSync(markerPath)).toBe(false);
    const firstSessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    expect(firstSessionOptions.model.headers).toEqual({});

    const result = await sendConductorWithReconnect(
      handle,
      'same prompt after expired credential',
      {
        conductorAgentFactory: factory,
        conductorOptions,
      },
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        message: 'litellm API error (401): Your client does not have permission',
      },
    });
    expect(prompts).toEqual(['same prompt after expired credential']);
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(2);
    await handle.conductor.close();
  });

  it('reports a failed custom models.json !command only when request auth is resolved', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    const markerPath = join(cwd, 'failed-command-ran');
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: `!touch ${markerPath}; printf 'COMMAND_CAUSE_SENTINEL' >&2; exit 7`,
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );
    mockGetModel.mockReturnValue(undefined);

    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'local/review-model',
      systemPrompt: 'system',
    });
    expect(mockCreateAgentSession).toHaveBeenCalledOnce();
    expect(existsSync(markerPath)).toBe(false);

    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    fakeSession.prompt.mockImplementation(async () => {
      const resources = await loadPiResources({
        cwd,
        pi: { agentDir, projectDir },
      });
      await resolvePiConductorApiKey({
        modelRuntime: sessionOptions.modelRuntime,
        resources,
        provider: 'local',
      });
    });

    await expect(conductor.send('request')).resolves.toMatchObject({
      status: 'error',
      error: {
        message:
          'API key auth failed for provider: failed to resolve API key for Pi provider from the configured command.',
      },
    });
    expect(existsSync(markerPath)).toBe(true);
    await conductor.close();
  });

  it('keeps project auth above a lower-precedence settings command during model resolution', async () => {
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    const markerPath = join(cwd, 'lower-precedence-command-ran');
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        apiKeys: {
          local: `!touch ${markerPath}; printf lower-precedence-key`,
        },
      }),
    );
    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({
        local: { type: 'api_key', key: 'project-key' },
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

    await expect(
      resolvePiModelConfig({
        cwd,
        pi: { agentDir, projectDir },
        modelId: 'local/review-model',
        env: {},
      }),
    ).resolves.toMatchObject({
      provider: 'local',
      apiKey: 'project-key',
      model: {
        headers: { Authorization: 'Bearer project-key' },
      },
    });
    expect(existsSync(markerPath)).toBe(false);
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

    const conductor = await createPiAgent({
      cwd,
      pi: { agentDir, projectDir },
      modelId: 'local/review-model',
      systemPrompt: 'system',
    });
    const sessionOptions = mockCreateAgentSession.mock.calls[0]![0];
    let requestAuth: unknown;
    fakeSession.prompt.mockImplementation(async () => {
      const resources = await loadPiResources({
        cwd,
        pi: { agentDir, projectDir },
      });
      requestAuth = await resolvePiConductorApiKey({
        modelRuntime: sessionOptions.modelRuntime,
        resources,
        provider: 'local',
      });
    });

    await expect(conductor.send('request')).resolves.toMatchObject({
      status: 'finished',
      modelId: 'review-model',
    });
    expect(requestAuth).toBe('project-command-key');
    await conductor.close();
  });
});
