import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSend, mockWait, mockCreate, mockResume } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockWait: vi.fn(),
  mockCreate: vi.fn(),
  mockResume: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: mockCreate,
    resume: mockResume,
  },
  AuthenticationError: class AuthenticationError extends Error {
    readonly code = 'unauthenticated';
    constructor(message: string) {
      super(message);
      this.name = 'AuthenticationError';
    }
  },
  CursorAgentError: class CursorAgentError extends Error {
    readonly isRetryable = false;
    constructor(message: string) {
      super(message);
      this.name = 'CursorAgentError';
    }
  },
}));

vi.mock('./configure-cursor-sdk-env.js', () => ({
  ensureCursorSdkRipgrepPath: vi.fn(),
}));

import { AuthenticationError } from '@cursor/sdk';
import { ConductorAgent } from './conductor-agent.js';

describe('ConductorAgent.send', () => {
  afterEach(() => {
    mockSend.mockReset();
    mockWait.mockReset();
    mockCreate.mockReset();
    mockResume.mockReset();
  });

  it('uses default model id when modelId is omitted', async () => {
    const original = process.env.CONDUCTOR_MODEL_ID;
    delete process.env.CONDUCTOR_MODEL_ID;
    mockCreate.mockResolvedValue({
      agentId: 'agent-1',
      send: mockSend,
      [Symbol.asyncDispose]: vi.fn(),
    });

    const conductor = await ConductorAgent.create({ cwd: '/repo' });

    try {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { id: 'default' },
        }),
      );
    } finally {
      await conductor.close();
      if (original === undefined) {
        delete process.env.CONDUCTOR_MODEL_ID;
      } else {
        process.env.CONDUCTOR_MODEL_ID = original;
      }
    }
  });

  it('forwards inline MCP servers to Agent.create', async () => {
    const mcpServers = {
      docs: {
        type: 'http' as const,
        url: 'https://example.test/mcp',
      },
    };
    mockCreate.mockResolvedValue({
      agentId: 'agent-1',
      send: mockSend,
      [Symbol.asyncDispose]: vi.fn(),
    });

    const conductor = await ConductorAgent.create({
      cwd: '/repo',
      mcpServers,
    });

    try {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ mcpServers }),
      );
    } finally {
      await conductor.close();
    }
  });

  it('forwards inline MCP servers to Agent.resume', async () => {
    const mcpServers = {
      shell: {
        type: 'stdio' as const,
        command: 'mcp-server',
      },
    };
    mockResume.mockResolvedValue({
      agentId: 'agent-1',
      send: mockSend,
      [Symbol.asyncDispose]: vi.fn(),
    });

    const conductor = await ConductorAgent.resume('agent-1', {
      cwd: '/repo',
      mcpServers,
    });

    try {
      expect(mockResume).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ mcpServers }),
      );
    } finally {
      await conductor.close();
    }
  });

  it('forwards tool-call-started to callbacks', async () => {
    const onToolCallStarted = vi.fn();
    mockCreate.mockResolvedValue({
      agentId: 'agent-1',
      send: mockSend,
      [Symbol.asyncDispose]: vi.fn(),
    });
    mockSend.mockImplementation(async (_prompt, options) => {
      mockWait.mockImplementation(async () => {
        options?.onDelta?.({
          update: {
            type: 'tool-call-started',
            callId: 'call-1',
            toolCall: { type: 'shell', args: { command: 'ls' } },
          },
        });
        return {
          status: 'finished',
          result: 'done',
        };
      });
      return { id: 'run-1', wait: mockWait };
    });
    mockWait.mockResolvedValue({
      status: 'finished',
      result: 'done',
    });

    const conductor = await ConductorAgent.create({ cwd: '/repo' });

    try {
      await conductor.send('hello', { onToolCallStarted });

      expect(onToolCallStarted).toHaveBeenCalledWith({
        runId: 'run-1',
        tool: 'shell',
        callId: 'call-1',
      });
    } finally {
      await conductor.close();
    }
  });

  it('returns error result instead of throwing on AuthenticationError', async () => {
    mockCreate.mockResolvedValue({
      agentId: 'agent-1',
      send: mockSend,
      [Symbol.asyncDispose]: vi.fn(),
    });
    mockSend.mockRejectedValue(new AuthenticationError('not logged in'));

    const conductor = await ConductorAgent.create({ cwd: '/repo' });

    try {
      const result = await conductor.send('hello');

      expect(result.status).toBe('error');
      expect(result.error?.message).toBe('not logged in');
    } finally {
      await conductor.close();
    }
  });
});
