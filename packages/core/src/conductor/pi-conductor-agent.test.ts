import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAgent,
  mockCreatePiMcpBridge,
  mockGetEnvApiKey,
  mockGetModel,
  mockGetModels,
  mockGetProviders,
} = vi.hoisted(() => ({
  mockAgent: vi.fn(),
  mockCreatePiMcpBridge: vi.fn(),
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

vi.mock('./pi-mcp-bridge.js', () => ({
  createPiMcpBridge: mockCreatePiMcpBridge,
}));

import { reconnectConductorAgent } from './conductor-send-reconnect.js';
import {
  createPiConductorAgentFactory,
  PiConductorAgent,
  resolvePiModelConfig,
} from './pi-conductor-agent.js';

describe('PiConductorAgent', () => {
  let cwd = '';
  let home = '';
  let listener: ((event: any) => void) | undefined;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let fakeAgent: {
    state: {
      systemPrompt: string;
      model: unknown;
      tools: unknown[];
      messages: unknown[];
    };
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
      fakeAgent.state.messages = [...(options.initialState.messages ?? [])];
      return fakeAgent;
    });
    mockCreatePiMcpBridge.mockReset();
    mockCreatePiMcpBridge.mockResolvedValue(undefined);
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

  it('installs the compiled prompt natively and adds project Pi extensions', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(join(piRoot, 'extensions'), { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );
    await writeFile(join(piRoot, 'SYSTEM.md'), 'this must not replace the prompt');
    await writeFile(
      join(piRoot, 'extensions', 'project-extension.mjs'),
      `export default (pi) => pi.registerTool({
        name: 'project_extension',
        description: 'Project extension',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'extension' }] }),
      });`,
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
    expect(agentOptions.initialState.tools).toHaveLength(2);
    expect(agentOptions.initialState.tools[0]).toMatchObject({
      name: 'prompt_worker',
      label: 'prompt_worker',
    });
    expect(agentOptions.initialState.tools[1]).toMatchObject({
      name: 'project_extension',
    });
    expect(agentOptions.sessionId).toBe(conductor.agentId);
    expect(agentOptions.getApiKey('anthropic')).toBe('file-key');

    await conductor.close();
    expect(fakeAgent.abort).toHaveBeenCalledOnce();
    expect(fakeAgent.waitForIdle).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('applies Pi skills to the native prompt and expands prompt resources on send', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(join(piRoot, 'skills', 'review'), { recursive: true });
    await mkdir(join(piRoot, 'prompts'), { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );
    await writeFile(
      join(piRoot, 'skills', 'review', 'SKILL.md'),
      '---\ndescription: review guidance\n---\nUse the review checklist.',
    );
    await writeFile(
      join(piRoot, 'prompts', 'review.md'),
      '---\ndescription: review template\n---\nReview issue $1.',
    );

    const conductor = await PiConductorAgent.create({
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'compiled system prompt',
    });

    expect(fakeAgent.state.systemPrompt).toContain('compiled system prompt');
    expect(fakeAgent.state.systemPrompt).toContain('Use the review checklist.');

    await conductor.send('/review 358');
    expect(fakeAgent.prompt).toHaveBeenCalledWith('Review issue 358.');
    await conductor.close();
  });

  it('loads resolved MCP tools into Pi and closes the bridge with the agent', async () => {
    const closeBridge = vi.fn().mockResolvedValue(undefined);
    const mcpTool = {
      name: 'mcp_docs_lookup',
      label: 'mcp_docs_lookup',
      description: 'MCP lookup',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(),
    };
    mockCreatePiMcpBridge.mockResolvedValue({
      tools: [mcpTool],
      close: closeBridge,
    });

    const mcpServers = {
      docs: { type: 'stdio' as const, command: 'docs-server' },
    };
    const conductor = await PiConductorAgent.create({
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
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
      mcpServers,
    });

    expect(mockCreatePiMcpBridge).toHaveBeenCalledWith(mcpServers, { cwd });
    expect(fakeAgent.state.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'prompt_worker' }),
        mcpTool,
      ]),
    );

    await conductor.close();
    expect(closeBridge).toHaveBeenCalledOnce();
  });

  it('reinjects the MCP bridge on resume and closes both bridge lifecycles', async () => {
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const secondClose = vi.fn().mockResolvedValue(undefined);
    const firstTool = { name: 'mcp_first_tool' };
    const secondTool = { name: 'mcp_second_tool' };
    mockCreatePiMcpBridge
      .mockResolvedValueOnce({ tools: [firstTool], close: firstClose })
      .mockResolvedValueOnce({ tools: [secondTool], close: secondClose });

    const mcpServers = {
      docs: { type: 'stdio' as const, command: 'docs-server' },
    };
    const options = {
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      mcpServers,
    };
    const created = await PiConductorAgent.create(options);
    expect(fakeAgent.state.tools).toContain(firstTool);

    await created.close();
    expect(firstClose).toHaveBeenCalledOnce();

    const resumed = await PiConductorAgent.resume(created.agentId, options);
    expect(mockCreatePiMcpBridge).toHaveBeenNthCalledWith(1, mcpServers, {
      cwd,
    });
    expect(mockCreatePiMcpBridge).toHaveBeenNthCalledWith(2, mcpServers, {
      cwd,
    });
    expect(fakeAgent.state.tools).toContain(secondTool);
    await resumed.close();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('rebuilds the MCP bridge during in-process reconnect', async () => {
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const secondClose = vi.fn().mockResolvedValue(undefined);
    const firstTool = { name: 'mcp_first_tool' };
    const secondTool = { name: 'mcp_second_tool' };
    mockCreatePiMcpBridge
      .mockResolvedValueOnce({ tools: [firstTool], close: firstClose })
      .mockResolvedValueOnce({ tools: [secondTool], close: secondClose });

    const mcpServers = {
      docs: { type: 'stdio' as const, command: 'docs-server' },
    };
    const options = {
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
      mcpServers,
    };
    const factory = createPiConductorAgentFactory();
    const first = await factory.create(options);
    const handle = { conductor: first };

    await reconnectConductorAgent(handle, {
      conductorAgentFactory: factory,
      conductorOptions: options,
    });

    expect(firstClose).toHaveBeenCalledOnce();
    expect(mockCreatePiMcpBridge).toHaveBeenNthCalledWith(2, mcpServers, {
      cwd,
    });
    expect(fakeAgent.state.tools).toContain(secondTool);
    await handle.conductor.close();
    expect(secondClose).toHaveBeenCalledOnce();
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

    const created = await PiConductorAgent.create({
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });
    await created.close();

    const conductor = await PiConductorAgent.resume(created.agentId, {
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    });

    expect(conductor.agentId).toBe(created.agentId);
    expect(mockAgent.mock.calls.at(-1)?.[0].sessionId).toBe(created.agentId);
    await conductor.close();
  });

  it('restores the persisted Pi transcript when resuming', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );

    const message = {
      role: 'user' as const,
      content: 'first prompt',
      timestamp: Date.now(),
    };
    fakeAgent.prompt.mockImplementation(async () => {
      fakeAgent.state.messages.push(message);
      listener?.({ type: 'agent_end', messages: [message] });
    });

    const created = await PiConductorAgent.create({
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'compiled prompt',
    });
    await created.send('first prompt');
    await created.close();

    const resumed = await PiConductorAgent.resume(created.agentId, {
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'recompiled prompt',
    });

    expect(mockAgent.mock.calls.at(-1)?.[0].initialState.messages).toEqual([
      message,
    ]);
    expect(mockAgent.mock.calls.at(-1)?.[0].initialState.systemPrompt).toBe(
      'recompiled prompt',
    );
    await resumed.close();
  });

  it('persists the user prompt and one failure message when an in-flight send is aborted', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );

    const userMessage = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'abort me' }],
      timestamp: Date.now(),
    };
    const failureMessage = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: '' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'model-1',
      stopReason: 'aborted' as const,
      errorMessage: 'aborted',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    };

    let releasePrompt!: () => void;
    const promptReleased = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    fakeAgent.prompt.mockImplementation(async () => {
      fakeAgent.state.messages.push(userMessage);
      markPromptStarted();
      await promptReleased;
    });
    fakeAgent.abort.mockImplementation(() => {
      fakeAgent.state.messages.push(failureMessage);
      listener?.({ type: 'agent_end', messages: [failureMessage] });
      releasePrompt();
    });

    const options = {
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    };
    const conductor = await PiConductorAgent.create(options);
    const sendPromise = conductor.send('abort me');
    await promptStarted;

    const closePromise = conductor.close();
    await expect(sendPromise).resolves.toMatchObject({ status: 'cancelled' });
    await closePromise;

    const resumed = await PiConductorAgent.resume(conductor.agentId, options);
    expect(mockAgent.mock.calls.at(-1)?.[0].initialState.messages).toEqual([
      userMessage,
      failureMessage,
    ]);
    await resumed.close();
  });

  it('reconnects a Pi agent with its failure transcript without duplication', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );

    const userMessage = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'reconnect me' }],
      timestamp: Date.now(),
    };
    const failureMessage = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: '' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'model-1',
      stopReason: 'error' as const,
      errorMessage: 'connection failed',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    };
    fakeAgent.prompt.mockImplementation(async () => {
      fakeAgent.state.messages.push(userMessage, failureMessage);
      listener?.({ type: 'agent_end', messages: [failureMessage] });
    });

    const options = {
      cwd,
      modelId: 'anthropic/model-1',
      systemPrompt: 'system',
    };
    const factory = createPiConductorAgentFactory();
    const first = await factory.create(options);
    const result = await first.send('reconnect me');
    expect(result.status).toBe('error');

    const handle = { conductor: first };
    await reconnectConductorAgent(handle, {
      conductorAgentFactory: factory,
      conductorOptions: options,
    });

    expect(handle.conductor.agentId).toBe(first.agentId);
    expect(mockAgent.mock.calls.at(-1)?.[0].initialState.messages).toEqual([
      userMessage,
      failureMessage,
    ]);
    await handle.conductor.close();
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
    const userPiRoot = join(home, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await mkdir(userPiRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'model-1' }),
    );
    await writeFile(
      join(piRoot, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', token: '$PI_TEST_KEY' } }),
    );
    await writeFile(
      join(userPiRoot, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'user-key' } }),
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

  it('resolves a custom model from the Pi models.json standard resource', async () => {
    const piRoot = join(cwd, '.ensemble', 'pi');
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      join(piRoot, 'settings.json'),
      JSON.stringify({ defaultProvider: 'local', defaultModel: 'review-model' }),
    );
    await writeFile(
      join(piRoot, 'models.json'),
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
        home,
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
