import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockClose, mockResume } = vi.hoisted(() => ({
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockResume: vi.fn(),
}));

vi.mock('./conductor-agent.js', () => ({
  ConductorAgent: {
    resume: mockResume,
  },
}));

import {
  sendConductorWithReconnect,
  type ConductorAgentHandle,
} from './conductor-send-reconnect.js';

function createHandle(send: ReturnType<typeof vi.fn>): ConductorAgentHandle {
  return {
    conductor: {
      agentId: 'agent-1',
      send,
      close: mockClose,
    } as never,
  };
}

describe('sendConductorWithReconnect', () => {
  afterEach(() => {
    mockClose.mockClear();
    mockResume.mockReset();
  });

  it('returns first send result when not auth-like', async () => {
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'ok',
    });
    const handle = createHandle(send);

    const result = await sendConductorWithReconnect(handle, 'hello', {
      conductorOptions: { cwd: '/repo' },
    });

    expect(result.status).toBe('finished');
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('resumes same agentId and retries once on auth-like error', async () => {
    const firstSend = vi.fn().mockResolvedValue({
      runId: '',
      status: 'error',
      error: { message: 'Authentication error' },
    });
    const secondSend = vi.fn().mockResolvedValue({
      runId: 'run-2',
      status: 'finished',
      result: 'recovered',
    });
    const handle = createHandle(firstSend);
    mockResume.mockImplementation(async () => ({
      agentId: 'agent-1',
      send: secondSend,
      close: mockClose,
    }));

    const onReconnectAttempt = vi.fn();
    const result = await sendConductorWithReconnect(handle, 'hello', {
      conductorOptions: { cwd: '/repo', modelId: 'composer-2.5' },
      onReconnectAttempt,
    });

    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', {
      cwd: '/repo',
      modelId: 'composer-2.5',
    });
    expect(secondSend).toHaveBeenCalledWith('hello');
    expect(onReconnectAttempt).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(result.status).toBe('finished');
    expect(handle.conductor.send).toBe(secondSend);
  });

  it('returns auth error after resume retry fails', async () => {
    const failingSend = vi.fn().mockResolvedValue({
      runId: '',
      status: 'error',
      error: { message: 'not logged in' },
    });
    const handle = createHandle(failingSend);
    mockResume.mockImplementation(async () => ({
      agentId: 'agent-1',
      send: failingSend,
      close: mockClose,
    }));

    const result = await sendConductorWithReconnect(handle, 'hello', {
      conductorOptions: { cwd: '/repo' },
    });

    expect(mockResume).toHaveBeenCalledOnce();
    expect(result.status).toBe('error');
  });
});
