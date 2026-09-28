import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAgent, mockGetEnvApiKey, mockGetModel, mockGetModels, mockGetProviders } =
  vi.hoisted(() => ({
    mockAgent: vi.fn(),
    mockGetEnvApiKey: vi.fn(),
    mockGetModel: vi.fn(),
    mockGetModels: vi.fn(),
    mockGetProviders: vi.fn(),
  }));

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: mockAgent,
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  getEnvApiKey: mockGetEnvApiKey,
  getModel: mockGetModel,
  getModels: mockGetModels,
  getProviders: mockGetProviders,
}));

import {
  PiConductorAgent,
  resolvePiModelConfig,
} from './pi-conductor-agent.js';

describe('PiConductorAgent', () => {
  let cwd = '';
  let home = '';
  let listener: ((event: any) => void) | undefined;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let fakeAgent: {
    state: { systemPrompt: string; model: unknown; tools: unknown[]; messages: unknown[] };
    subscribe: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    waitForIdle: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'pi-conductor-project-'));
    home = await mkdtemp(join(tmpdir(), 'pi-conductor-home-'));
    listener = undefined;
    unsubscribe = vi.fn();
    fakeAgent = {
      state: { systemPrompt: '', model: undefined, tools: [], messages: [] },
      subscribe: vi.fn((nextListener: (event: any) => void) => {
        listener = nextListener;
        return unsubscribe;
      }),
      prompt: vi.fn(),
      abort: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    mockAgent.mockReset();
    mockAgent.mockImplementation((options) => {
      fakeAgent.state.systemPrompt = options.initialState.systemPrompt;
      fakeAgent.state.model = options.initialState.model;
      fakeAgent.state.tools = options.initialState.tools;
      return fakeAgent;
    });
    mockGetEnvApiKey.mockReset();
    mockGetEnvApiKey.mockReturnValue(undefined);
    mockGetModel.mockReset();
    mockGetModel.mockReturnValue({
      id: 'model-1',
      provider: 'anthropic',
      api: 'anthropic-messages',
    });
    mockGetModels.mockReset();
    mockGetProviders.mockReset();
    mockGetProviders.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs the compiled prompt natively and exposes only harness tools', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );
    await writeFile(
      join(piRoot, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'file-key' } }),
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      modelId: 'default',
      systemPrompt: 'compiled system prompt',
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

    const agentOptions = mockAgent.mock.calls[0]![0];
    expect(agentOptions.initialState.systemPrompt).toBe('compiled system prompt');
    expect(agentOptions.initialState.tools).toHaveLength(1);
    expect(agentOptions.initialState.tools[0]).toMatchObject({
      name: 'prompt_worker',
      label: 'prompt_worker',
    });
    expect(agentOptions.sessionId).toBe(conductor.agentId);
    expect(agentOptions.getApiKey('anthropic')).toBe('file-key');

    await conductor.close();
    expect(fakeAgent.abort).toHaveBeenCalledOnce();
    expect(fakeAgent.waitForIdle).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('maps Pi tool events, text deltas, final text, and usage', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );
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
    const executeHarnessTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'worker dispatched' }],
    }));
    fakeAgent.prompt.mockImplementation(async () => {
      await (fakeAgent.state.tools[0] as any).execute('call-1', {});
      listener?.({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'prompt_worker',
        args: {},
      });
      listener?.({
        type: 'message_update',
        message: finalMessage,
        assistantMessageEvent: { type: 'text_delta', delta: 'started' },
      });
      listener?.({ type: 'agent_end', messages: [finalMessage] });
    });

    const onToolCallStarted = vi.fn();
    const onStreamText = vi.fn();
    const conductor = await PiConductorAgent.create({
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      onStreamText,
      customTools: {
        prompt_worker: {
          name: 'prompt_worker',
          description: 'Dispatch to worker',
          inputSchema: { type: 'object', properties: {} },
          execute: executeHarnessTool,
        },
      },
    });

    const result = await conductor.send('kickoff', { onToolCallStarted });

    expect(fakeAgent.prompt).toHaveBeenCalledWith('kickoff');
    expect(fakeAgent.prompt).not.toHaveBeenCalledWith('system');
    expect(onToolCallStarted).toHaveBeenCalledWith({
      runId: result.runId,
      tool: 'prompt_worker',
      callId: 'call-1',
    });
    expect(onStreamText).toHaveBeenCalledWith('started');
    expect(executeHarnessTool).toHaveBeenCalledWith({});
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
    await expect(conductor.getUsage()).resolves.toEqual({
      cost: { rawCostCents: 25, chargedCents: 25 },
    });
  });

  it('uses the supplied id as the Pi session id when resuming', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );

    const conductor = await PiConductorAgent.resume('pi-session-1', {
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    expect(conductor.agentId).toBe('pi-session-1');
    expect(mockAgent.mock.calls[0]?.[0].sessionId).toBe('pi-session-1');
    await conductor.close();
  });

  it('waits for an in-flight tool/send before closing the Pi agent', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );

    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const toolStarted = vi.fn();
    const executeHarnessTool = vi.fn(async () => {
      toolStarted();
      await toolReleased;
      return { content: [{ type: 'text' as const, text: 'done' }] };
    });

    fakeAgent.prompt.mockImplementation(async () => {
      await (fakeAgent.state.tools[0] as any).execute('call-1', {});
      listener?.({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            model: 'model-1',
            stopReason: 'stop',
            usage: {
              input: 1,
              output: 1,
              totalTokens: 2,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0 },
            },
          },
        ],
      });
    });
    fakeAgent.abort.mockImplementation(() => {
      releaseTool();
    });
    fakeAgent.waitForIdle.mockImplementation(() => idle);

    const conductor = await PiConductorAgent.create({
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      customTools: {
        prompt_worker: {
          name: 'prompt_worker',
          description: 'Dispatch to worker',
          inputSchema: { type: 'object', properties: {} },
          execute: executeHarnessTool,
        },
      },
    });

    const sendPromise = conductor.send('in-flight');
    await vi.waitFor(() => expect(toolStarted).toHaveBeenCalledOnce());

    const closePromise = conductor.close();
    expect(fakeAgent.abort).toHaveBeenCalledOnce();
    expect(fakeAgent.waitForIdle).toHaveBeenCalledOnce();
    let closeSettled = false;
    void closePromise.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(unsubscribe).not.toHaveBeenCalled();

    resolveIdle();
    await closePromise;
    await sendPromise;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('uses Pi settings and auth files without requiring ensemble auth', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );
    await writeFile(
      join(piRoot, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: '$PI_TEST_KEY' } }),
    );

    await expect(
      resolvePiModelConfig({
        cwd,
        home,
        env: { PI_TEST_KEY: 'expanded-key' },
      }),
    ).resolves.toMatchObject({
      provider: 'anthropic',
      modelId: 'model-1',
      apiKey: 'expanded-key',
    });
  });
});
