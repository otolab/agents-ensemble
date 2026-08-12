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
