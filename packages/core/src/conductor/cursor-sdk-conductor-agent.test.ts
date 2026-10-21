import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAgent, send, cancel, wait } = vi.hoisted(() => ({
  createAgent: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: { create: createAgent },
  AuthenticationError: class AuthenticationError extends Error {},
  CursorAgentError: class CursorAgentError extends Error {
    isRetryable = false;
  },
}));

import { CursorSdkConductorAgent } from './cursor-sdk-conductor-agent.js';

describe('CursorSdkConductorAgent', () => {
  beforeEach(() => {
    createAgent.mockReset();
    send.mockReset();
    cancel.mockReset();
    wait.mockReset();
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
