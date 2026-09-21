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
  isConductorSendTransportError,
  reconnectConductorAgent,
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
      conductorOptions: {
        cwd: '/repo',
        modelId: 'composer-2.5',
        mcpServers: {
          docs: { type: 'http', url: 'https://example.test/mcp' },
        },
      },
      onReconnectAttempt,
    });

    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', {
      cwd: '/repo',
      modelId: 'composer-2.5',
      mcpServers: {
        docs: { type: 'http', url: 'https://example.test/mcp' },
      },
    });
    expect(secondSend).toHaveBeenCalledWith('hello', expect.any(Object));
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

  it('reconnects and retries once on a transport stall', async () => {
    const firstSend = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'error',
      error: { message: 'Connection stalled repeatedly' },
    });
    const secondSend = vi.fn().mockResolvedValue({
      runId: 'run-2',
      status: 'finished',
      result: 'recovered',
    });
    const handle = createHandle(firstSend);
    mockResume.mockResolvedValue({
      agentId: 'agent-1',
      send: secondSend,
      close: mockClose,
    });

    const onAuthReconnectAttempt = vi.fn();
    const onTransportReconnectAttempt = vi.fn();
    const onTransportReconnectComplete = vi.fn();
    const result = await sendConductorWithReconnect(handle, 'same prompt', {
      conductorOptions: { cwd: '/repo' },
      onAuthReconnectAttempt,
      onTransportReconnectAttempt,
      onTransportReconnectComplete,
    });

    expect(result.status).toBe('finished');
    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', { cwd: '/repo' });
    expect(secondSend).toHaveBeenCalledWith('same prompt', expect.any(Object));
    expect(onAuthReconnectAttempt).not.toHaveBeenCalled();
    expect(onTransportReconnectAttempt).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(onTransportReconnectComplete).toHaveBeenCalledWith({
      agentId: 'agent-1',
      success: true,
    });
  });

  it('does not reconnect for unrelated conductor errors', async () => {
    const result = {
      runId: 'run-1',
      status: 'error' as const,
      error: { message: 'Model Blocked' },
    };
    const send = vi.fn().mockResolvedValue(result);

    await expect(
      sendConductorWithReconnect(createHandle(send), 'hello', {
        conductorOptions: { cwd: '/repo' },
      }),
    ).resolves.toEqual(result);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('returns the original transport error when reconnect fails', async () => {
    const result = {
      runId: 'run-1',
      status: 'error' as const,
      error: { message: 'Connection stalled repeatedly' },
    };
    const send = vi.fn().mockResolvedValue(result);
    mockResume.mockRejectedValue(new Error('resume unavailable'));
    const onTransportReconnectComplete = vi.fn();

    await expect(
      sendConductorWithReconnect(createHandle(send), 'hello', {
        conductorOptions: { cwd: '/repo' },
        onTransportReconnectComplete,
      }),
    ).resolves.toEqual(result);
    expect(send).toHaveBeenCalledOnce();
    expect(onTransportReconnectComplete).toHaveBeenCalledWith({
      agentId: 'agent-1',
      success: false,
      error: 'resume unavailable',
    });
  });
});

describe('reconnectConductorAgent', () => {
  afterEach(() => {
    mockClose.mockClear();
    mockResume.mockReset();
  });

  it('closes and resumes the same agent id', async () => {
    const oldSend = vi.fn();
    const resumed = {
      agentId: 'agent-1',
      send: vi.fn(),
      close: mockClose,
    };
    const handle = createHandle(oldSend);
    mockResume.mockResolvedValue(resumed);
    const onReconnectAttempt = vi.fn();

    await expect(
      reconnectConductorAgent(handle, {
        cwd: '/repo',
        onReconnectAttempt,
      }),
    ).resolves.toBe('agent-1');

    expect(onReconnectAttempt).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', { cwd: '/repo' });
    expect(handle.conductor).toBe(resumed);
  });
});

describe('isConductorSendTransportError', () => {
  it('detects stall messages and transport codes', () => {
    expect(
      isConductorSendTransportError({
        runId: 'run-1',
        status: 'error',
        error: { message: 'Connection stalled repeatedly' },
      }),
    ).toBe(true);
    expect(
      isConductorSendTransportError({
        runId: 'run-2',
        status: 'error',
        error: { code: 'ERR_CONNECTION_STALLED' },
      }),
    ).toBe(true);
  });

  it('does not classify auth or model errors as transport errors', () => {
    expect(
      isConductorSendTransportError({
        runId: 'run-1',
        status: 'error',
        error: { message: 'Authentication error' },
      }),
    ).toBe(false);
    expect(
      isConductorSendTransportError({
        runId: 'run-2',
        status: 'error',
        error: { message: 'Model Blocked' },
      }),
    ).toBe(false);
  });
});
