import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAgent, resumeAgent, listModels, send, cancel, wait } = vi.hoisted(() => ({
  createAgent: vi.fn(),
  resumeAgent: vi.fn(),
  listModels: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: { create: createAgent, resume: resumeAgent },
  Cursor: { models: { list: listModels } },
  AuthenticationError: class AuthenticationError extends Error {},
  CursorAgentError: class CursorAgentError extends Error {
    isRetryable = false;
  },
}));

import { CursorSdkConductorAgent } from './cursor-sdk-conductor-agent.js';

describe('CursorSdkConductorAgent', () => {
  beforeEach(() => {
    createAgent.mockReset();
    resumeAgent.mockReset();
    listModels.mockReset();
    send.mockReset();
    cancel.mockReset();
    wait.mockReset();
  });

  it('maps conductor reasoning through the unique matching Cursor catalog parameter', async () => {
    const agent = {
      agentId: 'agent-1',
      [Symbol.asyncDispose]: vi.fn(),
    };
    listModels.mockResolvedValue([
      {
        id: 'model-1',
        displayName: 'Model 1',
        parameters: [
          {
            id: 'reasoning_effort',
            displayName: 'Reasoning effort',
            values: [{ value: 'low' }, { value: 'high' }],
          },
        ],
      },
    ]);
    createAgent.mockResolvedValue(agent);

    await CursorSdkConductorAgent.create({
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-1',
      reasoning: 'high',
      apiKey: 'cursor-test-key',
    });

    expect(listModels).toHaveBeenCalledWith({ apiKey: 'cursor-test-key' });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: 'model-1',
          params: [{ id: 'reasoning_effort', value: 'high' }],
        },
      }),
    );
  });

  it('prefers an exact catalog model ID over an alias from another entry', async () => {
    createAgent.mockResolvedValue({
      agentId: 'agent-1',
      [Symbol.asyncDispose]: vi.fn(),
    });
    listModels.mockResolvedValue([
      {
        id: 'other-model',
        aliases: ['model-1'],
        displayName: 'Other model',
        parameters: [
          {
            id: 'reasoning_effort',
            values: [{ value: 'high' }],
          },
        ],
      },
      {
        id: 'model-1',
        displayName: 'Exact model',
        parameters: [
          {
            id: 'thinking_level',
            values: [{ value: 'max' }],
          },
        ],
      },
    ]);

    await CursorSdkConductorAgent.create({
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-1',
      reasoning: 'max',
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: 'model-1',
          params: [{ id: 'thinking_level', value: 'max' }],
        },
      }),
    );
  });

  it('resolves a catalog model alias', async () => {
    createAgent.mockResolvedValue({
      agentId: 'agent-1',
      [Symbol.asyncDispose]: vi.fn(),
    });
    listModels.mockResolvedValue([
      {
        id: 'canonical-model',
        aliases: ['model-alias'],
        displayName: 'Canonical model',
        parameters: [
          {
            id: 'effort',
            values: [{ value: 'high' }],
          },
        ],
      },
    ]);

    await CursorSdkConductorAgent.create({
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-alias',
      reasoning: 'high',
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: 'model-alias',
          params: [{ id: 'effort', value: 'high' }],
        },
      }),
    );
  });

  it('can map a reasoning value from a model variant when parameter definitions are absent', async () => {
    createAgent.mockResolvedValue({
      agentId: 'agent-1',
      [Symbol.asyncDispose]: vi.fn(),
    });
    listModels.mockResolvedValue([
      {
        id: 'model-1',
        displayName: 'Model 1',
        variants: [
          {
            displayName: 'High',
            params: [{ id: 'reasoning_effort', value: 'high' }],
          },
        ],
      },
    ]);

    await CursorSdkConductorAgent.create({
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-1',
      reasoning: 'high',
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: 'model-1',
          params: [{ id: 'reasoning_effort', value: 'high' }],
        },
      }),
    );
  });

  it('does not query the model catalog when reasoning is omitted', async () => {
    createAgent.mockResolvedValue({
      agentId: 'agent-1',
      [Symbol.asyncDispose]: vi.fn(),
    });

    await CursorSdkConductorAgent.create({
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-1',
    });

    expect(listModels).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: 'model-1' } }),
    );
  });

  it('rejects a blank reasoning value before querying the model catalog', async () => {
    await expect(
      CursorSdkConductorAgent.create({
        cwd: '/repo',
        systemPrompt: 'system',
        modelId: 'model-1',
        reasoning: '  ',
      }),
    ).rejects.toThrow('Cursor conductor reasoning must be a non-empty string.');

    expect(listModels).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('fails when the selected model is absent from the Cursor catalog', async () => {
    listModels.mockResolvedValue([]);

    await expect(
      CursorSdkConductorAgent.create({
        cwd: '/repo',
        systemPrompt: 'system',
        modelId: 'model-1',
        reasoning: 'high',
      }),
    ).rejects.toThrow(/was not returned by Cursor\.models\.list/);

    expect(createAgent).not.toHaveBeenCalled();
  });

  it('fails when a model alias matches multiple Cursor catalog entries', async () => {
    listModels.mockResolvedValue([
      {
        id: 'model-1',
        aliases: ['shared-alias'],
        displayName: 'Model 1',
        parameters: [{ id: 'reasoning_effort', values: [{ value: 'high' }] }],
      },
      {
        id: 'model-2',
        aliases: ['shared-alias'],
        displayName: 'Model 2',
        parameters: [{ id: 'reasoning_effort', values: [{ value: 'high' }] }],
      },
    ]);

    await expect(
      CursorSdkConductorAgent.create({
        cwd: '/repo',
        systemPrompt: 'system',
        modelId: 'shared-alias',
        reasoning: 'high',
      }),
    ).rejects.toThrow(/matches multiple entries in Cursor\.models\.list/);

    expect(createAgent).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'missing value',
      parameters: [
        {
          id: 'reasoning_effort',
          values: [{ value: 'low' }, { value: 'medium' }],
        },
      ],
      error: /does not support reasoning value "high"/,
    },
    {
      label: 'ambiguous parameters',
      parameters: [
        { id: 'reasoning_effort', values: [{ value: 'high' }] },
        { id: 'thinking_level', values: [{ value: 'high' }] },
      ],
      error: /has ambiguous reasoning parameters for value "high"/,
    },
    {
      label: 'no reasoning parameter',
      parameters: [{ id: 'fast', values: [{ value: 'true' }] }],
      error: /has no identifiable reasoning parameter/,
    },
  ])('fails before creating the agent for $label', async ({ parameters, error }) => {
    listModels.mockResolvedValue([
      { id: 'model-1', displayName: 'Model 1', parameters },
    ]);

    await expect(
      CursorSdkConductorAgent.create({
        cwd: '/repo',
        systemPrompt: 'system',
        modelId: 'model-1',
        reasoning: 'high',
      }),
    ).rejects.toThrow(error);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('uses the same catalog reasoning selection when resuming', async () => {
    const agent = {
      agentId: 'agent-1',
      [Symbol.asyncDispose]: vi.fn(),
    };
    listModels.mockResolvedValue([
      {
        id: 'model-1',
        displayName: 'Model 1',
        parameters: [
          {
            id: 'thinking',
            values: [{ value: 'high', displayName: 'High' }],
          },
        ],
      },
    ]);
    resumeAgent.mockResolvedValue(agent);

    await CursorSdkConductorAgent.resume('agent-1', {
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-1',
      reasoning: 'High',
    });

    expect(resumeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        model: {
          id: 'model-1',
          params: [{ id: 'thinking', value: 'high' }],
        },
      }),
    );
  });

  it('cancels the active Cursor run', async () => {
    let resolveWait!: (value: {
      status: string;
      result: string;
    }) => void;
    const run = {
      id: 'run-1',
      wait,
      cancel,
      supports: vi.fn(() => true),
      usage: undefined,
    };
    const agent = {
      agentId: 'agent-1',
      send,
      reload: vi.fn(),
      getUsage: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    };
    createAgent.mockResolvedValue(agent);
    send.mockResolvedValue(run);
    cancel.mockResolvedValue(undefined);
    wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWait = resolve;
        }),
    );

    const conductor = await CursorSdkConductorAgent.create({
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-1',
    });
    const sendPromise = conductor.send('working');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());

    await conductor.cancel();

    expect(run.supports).toHaveBeenCalledWith('cancel');
    expect(cancel).toHaveBeenCalledOnce();
    resolveWait({
      status: 'cancelled',
      result: 'partial output',
    });
    await expect(sendPromise).resolves.toMatchObject({
      status: 'cancelled',
      result: 'partial output',
    });
  });

  it('cancels a run whose SDK send has not returned the run handle yet', async () => {
    let resolveWait!: (value: {
      status: string;
      result: string;
    }) => void;
    const run = {
      id: 'run-1',
      wait,
      cancel,
      supports: vi.fn(() => true),
      usage: undefined,
    };
    let resolveRun!: (value: typeof run) => void;
    const agent = {
      agentId: 'agent-1',
      send,
      reload: vi.fn(),
      getUsage: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    };
    createAgent.mockResolvedValue(agent);
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    cancel.mockResolvedValue(undefined);
    wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWait = resolve;
        }),
    );

    const conductor = await CursorSdkConductorAgent.create({
      cwd: '/repo',
      systemPrompt: 'system',
      modelId: 'model-1',
    });
    const sendPromise = conductor.send('working');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const cancelPromise = conductor.cancel();

    resolveRun(run);
    await cancelPromise;

    expect(run.supports).toHaveBeenCalledWith('cancel');
    expect(cancel).toHaveBeenCalledOnce();
    resolveWait({
      status: 'cancelled',
      result: 'partial output',
    });
    await expect(sendPromise).resolves.toMatchObject({ status: 'cancelled' });
  });
});
