import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockLogout } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Cursor: {
    auth: {
      logout: mockLogout,
    },
  },
  getDefaultSdkAuthPath: () => '/tmp/auth.json',
}));

import {
  formatConductorAuthRecoveryHint,
  isBareConductorSendAuthError,
  isConductorAuthError,
  isConductorSendAuthError,
  logoutConductor,
} from './conductor-auth.js';

describe('isConductorAuthError', () => {
  it('detects Authentication error message', () => {
    expect(
      isConductorAuthError(
        'Authentication error If you are logged in, try logging out and back in.',
      ),
    ).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isConductorAuthError('Model Blocked')).toBe(false);
  });

  it.each([
    'No API key for provider: anthropic',
    '401 Unauthorized',
  ])('detects Pi provider auth failure: %s', (message) => {
    expect(isConductorAuthError(message)).toBe(true);
  });
});

describe('isBareConductorSendAuthError', () => {
  it('detects bare status error without message', () => {
    expect(
      isBareConductorSendAuthError({
        runId: 'run-1',
        status: 'error',
      }),
    ).toBe(true);
  });

  it('returns false when error message is present', () => {
    expect(
      isBareConductorSendAuthError({
        runId: 'run-1',
        status: 'error',
        error: { message: 'Model Blocked' },
      }),
    ).toBe(false);
  });
});

describe('isConductorSendAuthError', () => {
  it('detects explicit auth message', () => {
    expect(
      isConductorSendAuthError({
        runId: 'run-1',
        status: 'error',
        error: { message: 'Authentication error' },
      }),
    ).toBe(true);
  });

  it('detects bare auth-like error', () => {
    expect(
      isConductorSendAuthError({
        runId: 'run-1',
        status: 'error',
      }),
    ).toBe(true);
  });
});

describe('formatConductorAuthRecoveryHint', () => {
  afterEach(() => {
    delete process.env.CURSOR_API_KEY;
  });

  it('includes logout and resume for stored login mode', () => {
    expect(formatConductorAuthRecoveryHint('agent-1')).toContain('ensemble auth logout');
    expect(formatConductorAuthRecoveryHint('agent-1')).toContain('--resume agent-1');
  });

  it('guides CURSOR_API_KEY users without logout step', () => {
    process.env.CURSOR_API_KEY = 'cursor_test';

    const hint = formatConductorAuthRecoveryHint('agent-1');

    expect(hint).toContain('CURSOR_API_KEY');
    expect(hint).not.toMatch(/ensemble auth logout →/);
  });

  it('gives Pi users a provider-specific login and auth-file hint', () => {
    const hint = formatConductorAuthRecoveryHint('agent-1', {
      backend: 'pi',
      provider: 'anthropic',
      pi: { agentDir: '/tmp/ensemble-pi' },
    });

    expect(hint).toContain('provider=anthropic');
    expect(hint).toContain('ensemble auth login --provider anthropic');
    expect(hint).toContain('/tmp/ensemble-pi/auth.json');
    expect(hint).toContain('--resume agent-1');
    expect(hint).not.toContain('ensemble auth logout');
  });
});

describe('logoutConductor', () => {
  it('calls Cursor.auth.logout', async () => {
    mockLogout.mockResolvedValue(undefined);

    await logoutConductor();

    expect(mockLogout).toHaveBeenCalledOnce();
  });
});
