import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSend, mockClose, mockResume, mockLogout, mockLogin } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockResume: vi.fn(),
  mockLogout: vi.fn(),
  mockLogin: vi.fn(),
}));

vi.mock('./conductor-agent.js', () => ({
  ConductorAgent: {
    resume: mockResume,
  },
}));

vi.mock('./conductor-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conductor-auth.js')>();
  return {
    ...actual,
    logoutConductor: mockLogout,
    loginConductor: mockLogin,
  };
});

import {
  sendConductorWithReconnect,
  type ConductorAgentHandle,
} from './conductor-send-reconnect.js';

function createHandle(send: typeof mockSend): ConductorAgentHandle {
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
    mockSend.mockReset();
    mockClose.mockClear();
    mockResume.mockReset();
    mockLogout.mockReset();
    mockLogin.mockReset();
  });

  it('returns first send result when not auth-like', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'ok',
    });
    const handle = createHandle(mockSend);

    const result = await sendConductorWithReconnect(handle, 'hello', {
      conductorOptions: { cwd: '/repo' },
      enableTtyReauth: false,
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
      enableTtyReauth: false,
      onReconnectAttempt,
    });

    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', {
      cwd: '/repo',
      modelId: 'composer-2.5',
    });
    expect(secondSend).toHaveBeenCalledWith('hello');
    expect(onReconnectAttempt).toHaveBeenCalledWith({
      phase: 'resume',
      agentId: 'agent-1',
    });
    expect(result.status).toBe('finished');
    expect(handle.conductor.send).toBe(secondSend);
  });

  it('attempts tty reauth when resume retry still fails', async () => {
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
    mockLogout.mockResolvedValue(undefined);
    mockLogin.mockResolvedValue({ apiKey: 'new-key' });

    const onReconnectAttempt = vi.fn();
    const result = await sendConductorWithReconnect(handle, 'hello', {
      conductorOptions: { cwd: '/repo' },
      enableTtyReauth: true,
      onReconnectAttempt,
    });

    expect(mockLogout).toHaveBeenCalledOnce();
    expect(mockLogin).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledTimes(2);
    expect(onReconnectAttempt).toHaveBeenCalledWith({
      phase: 'reauth',
      agentId: 'agent-1',
    });
    expect(result.status).toBe('error');
  });

  it('does not attempt tty reauth when disabled', async () => {
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

    await sendConductorWithReconnect(handle, 'hello', {
      conductorOptions: { cwd: '/repo' },
      enableTtyReauth: false,
    });

    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockResume).toHaveBeenCalledOnce();
  });
});
