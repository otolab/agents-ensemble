import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockClose, mockResume, mockCreate } = vi.hoisted(() => ({
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockResume: vi.fn(),
  mockCreate: vi.fn(),
}));

function createFactory() {
  return { create: mockCreate, resume: mockResume };
}

function createConductorOptions() {
  return { cwd: '/repo', systemPrompt: 'system prompt' };
}

import {
  isConductorSendTransportError,
  reconnectConductorAgent,
  sendConductorWithReconnect,
  type ConductorAgentHandle,
} from './conductor-send-reconnect.js';

const PI_API_KEY_RESOLUTION_ERROR =
  'API key auth failed for provider litellm: Failed to resolve API key for provider "litellm" from shell command: cached-auth.mjs -- gcloud auth print-identity-token';

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
      conductorAgentFactory: createFactory(),
      conductorOptions: createConductorOptions(),
    });

    expect(result.status).toBe('finished');
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('resumes the same agentId but does not replay an auth-failed prompt', async () => {
    const firstSend = vi.fn().mockResolvedValue({
      runId: '',
      status: 'error',
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
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
    const onAutomaticRetry = vi.fn();
    const result = await sendConductorWithReconnect(handle, 'hello', {
      conductorAgentFactory: createFactory(),
      conductorOptions: {
        cwd: '/repo',
        systemPrompt: 'system prompt',
        modelId: 'composer-2.5',
        mcpServers: {
          docs: { type: 'http', url: 'https://example.test/mcp' },
        },
      },
      onReconnectAttempt,
      onAutomaticRetry,
    });

    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledOnce();
    expect(firstSend).toHaveBeenCalledOnce();
    expect(secondSend).not.toHaveBeenCalled();
    expect(mockResume).toHaveBeenCalledWith('agent-1', {
      cwd: '/repo',
      systemPrompt: 'system prompt',
      modelId: 'composer-2.5',
      mcpServers: {
        docs: { type: 'http', url: 'https://example.test/mcp' },
      },
    });
    expect(onReconnectAttempt).toHaveBeenCalledWith({
      agentId: 'agent-1',
      source: 'automatic',
    });
    expect(onAutomaticRetry).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    expect(handle.conductor.send).toBe(secondSend);
  });

  it.each([
    {
      kind: 'auth',
      result: {
        runId: 'run-auth-error',
        status: 'error' as const,
        error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
      },
    },
    {
      kind: 'transport',
      result: {
        runId: 'run-transport-error',
        status: 'error' as const,
        error: { message: 'Connection stalled repeatedly' },
      },
    },
  ])(
    'resumes but does not replay the prompt after a tool starts ($kind)',
    async ({ result }) => {
      const firstSend = vi.fn(
        async (
          _message: string,
          callbacks?: {
            onToolCallStarted?: (info: {
              runId: string;
              tool: string;
              callId: string;
            }) => void;
          },
        ) => {
          callbacks?.onToolCallStarted?.({
            runId: 'run-with-tool',
            tool: 'prompt_worker',
            callId: 'call-1',
          });
          return result;
        },
      );
      const resumedSend = vi.fn();
      const handle = createHandle(firstSend);
      mockResume.mockResolvedValue({
        agentId: 'agent-1',
        send: resumedSend,
        close: mockClose,
      });
      const onToolCallStarted = vi.fn();
      const onAutomaticRetry = vi.fn();

      await expect(
        sendConductorWithReconnect(handle, 'dispatch with possible side effects', {
          conductorAgentFactory: createFactory(),
          conductorOptions: createConductorOptions(),
          onToolCallStarted,
          onAutomaticRetry,
        }),
      ).resolves.toEqual(result);

      expect(firstSend).toHaveBeenCalledOnce();
      expect(mockResume).toHaveBeenCalledWith('agent-1', createConductorOptions());
      expect(onToolCallStarted).toHaveBeenCalledWith({
        runId: 'run-with-tool',
        tool: 'prompt_worker',
        callId: 'call-1',
      });
      expect(resumedSend).not.toHaveBeenCalled();
      expect(onAutomaticRetry).not.toHaveBeenCalled();
    },
  );

  it('returns auth error after resume without retrying the prompt', async () => {
    const failingSend = vi.fn().mockResolvedValue({
      runId: '',
      status: 'error',
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
    });
    const handle = createHandle(failingSend);
    mockResume.mockImplementation(async () => ({
      agentId: 'agent-1',
      send: failingSend,
      close: mockClose,
    }));

    const onAutomaticRetry = vi.fn();
    const result = await sendConductorWithReconnect(handle, 'hello', {
      conductorAgentFactory: createFactory(),
      conductorOptions: createConductorOptions(),
      onAutomaticRetry,
    });

    expect(mockResume).toHaveBeenCalledOnce();
    expect(failingSend).toHaveBeenCalledOnce();
    expect(onAutomaticRetry).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
  });

  it('reconnects on a transport stall without replaying the prompt', async () => {
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
      conductorAgentFactory: createFactory(),
      conductorOptions: createConductorOptions(),
      onAuthReconnectAttempt,
      onTransportReconnectAttempt,
      onTransportReconnectComplete,
    });

    expect(result.status).toBe('error');
    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', {
      cwd: '/repo',
      systemPrompt: 'system prompt',
    });
    expect(firstSend).toHaveBeenCalledOnce();
    expect(secondSend).not.toHaveBeenCalled();
    expect(onAuthReconnectAttempt).not.toHaveBeenCalled();
    expect(onTransportReconnectAttempt).toHaveBeenCalledWith({
      agentId: 'agent-1',
      source: 'automatic',
    });
    expect(onTransportReconnectComplete).toHaveBeenCalledWith({
      agentId: 'agent-1',
      success: true,
      source: 'automatic',
    });
  });

  it('does not retry a transport error after shutdown has aborted the send', async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {
      controller.abort();
      return {
        runId: 'run-1',
        status: 'error',
        error: { message: 'Connection stalled repeatedly' },
      };
    });

    const result = await sendConductorWithReconnect(createHandle(send), 'answer', {
      conductorAgentFactory: createFactory(),
      conductorOptions: createConductorOptions(),
      signal: controller.signal,
    });

    expect(result.status).toBe('error');
    expect(send).toHaveBeenCalledOnce();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('does not reconnect when shutdown intent arrives before a transport error settles', async () => {
    const shutdownIntent = new AbortController();
    const send = vi.fn(async () => {
      shutdownIntent.abort();
      return {
        runId: 'run-1',
        status: 'error' as const,
        error: { message: 'Connection stalled repeatedly' },
      };
    });

    const result = await sendConductorWithReconnect(createHandle(send), 'answer', {
      conductorAgentFactory: createFactory(),
      conductorOptions: createConductorOptions(),
      retrySuppressionSignal: shutdownIntent.signal,
    });

    expect(result.status).toBe('error');
    expect(send).toHaveBeenCalledOnce();
    expect(mockResume).not.toHaveBeenCalled();
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
        conductorAgentFactory: createFactory(),
        conductorOptions: createConductorOptions(),
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
    const onAutomaticRetry = vi.fn();

    await expect(
      sendConductorWithReconnect(createHandle(send), 'hello', {
        conductorAgentFactory: createFactory(),
        conductorOptions: createConductorOptions(),
        onTransportReconnectComplete,
        onAutomaticRetry,
      }),
    ).resolves.toEqual(result);
    expect(send).toHaveBeenCalledOnce();
    expect(onAutomaticRetry).not.toHaveBeenCalled();
    expect(onTransportReconnectComplete).toHaveBeenCalledWith({
      agentId: 'agent-1',
      success: false,
      source: 'automatic',
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
        conductorAgentFactory: createFactory(),
        cwd: '/repo',
        systemPrompt: 'system prompt',
        onReconnectAttempt,
      }),
    ).resolves.toBe('agent-1');

    expect(onReconnectAttempt).toHaveBeenCalledWith({
      agentId: 'agent-1',
      source: 'manual',
    });
    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', {
      cwd: '/repo',
      systemPrompt: 'system prompt',
    });
    expect(handle.conductor).toBe(resumed);
  });

  it('retries resume without closing the already-closed agent again', async () => {
    const handle = createHandle(vi.fn());
    const resumed = {
      agentId: 'agent-1',
      send: vi.fn(),
      close: vi.fn(),
    };
    mockResume
      .mockRejectedValueOnce(new Error('resume unavailable'))
      .mockResolvedValueOnce(resumed);

    await expect(
      reconnectConductorAgent(handle, {
        conductorAgentFactory: createFactory(),
        conductorOptions: createConductorOptions(),
      }),
    ).rejects.toThrow('resume unavailable');

    await expect(
      reconnectConductorAgent(handle, {
        conductorAgentFactory: createFactory(),
        conductorOptions: createConductorOptions(),
      }),
    ).resolves.toBe('agent-1');

    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledTimes(2);
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
