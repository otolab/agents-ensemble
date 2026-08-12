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
  isConductorAuthError,
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
});

describe('logoutConductor', () => {
  it('calls Cursor.auth.logout', async () => {
    mockLogout.mockResolvedValue(undefined);

    await logoutConductor();

    expect(mockLogout).toHaveBeenCalledOnce();
  });
});
