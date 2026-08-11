import { describe, expect, it, vi } from 'vitest';

vi.mock('@agents-ensemble/core', () => ({
  loadProfile: vi.fn(),
  runIssueSession: vi.fn(),
  SessionLogger: vi.fn(),
}));

import { executeIssueCommand, resolveIssueSessionMaxTurns } from './issue-command.js';

const baseOptions = {
  repoRoot: '/tmp/repo',
  conductorCwd: '/tmp/cwd',
  worktree: 'isolated',
};

describe('resolveIssueSessionMaxTurns', () => {
  it('returns 0 for interactive default', () => {
    expect(resolveIssueSessionMaxTurns({}, true)).toBe(0);
  });

  it('returns 5 for non-interactive default', () => {
    expect(resolveIssueSessionMaxTurns({}, false)).toBe(5);
  });
});

describe('executeIssueCommand maxTurns wiring', () => {
  it('passes maxTurns 0 to runIssueSession when interactive without flags', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand('https://github.com/org/repo/issues/1', baseOptions, {
      isOperatorInputInteractive: () => true,
      runIssueSession,
      loadProfile,
      SessionLogger,
    });

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 0 }),
    );
  });

  it('passes maxTurns 0 to runIssueSession when --no-max-turns is set', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand(
      'https://github.com/org/repo/issues/1',
      { ...baseOptions, noMaxTurns: true },
      {
        isOperatorInputInteractive: () => false,
        runIssueSession,
        loadProfile,
        SessionLogger,
      },
    );

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 0 }),
    );
  });

  it('passes maxTurns 5 to runIssueSession when non-interactive without flags', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand('https://github.com/org/repo/issues/1', baseOptions, {
      isOperatorInputInteractive: () => false,
      runIssueSession,
      loadProfile,
      SessionLogger,
    });

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 5 }),
    );
  });

  it('passes explicit --max-turns to runIssueSession', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand(
      'https://github.com/org/repo/issues/1',
      { ...baseOptions, maxTurns: 10 },
      {
        isOperatorInputInteractive: () => false,
        runIssueSession,
        loadProfile,
        SessionLogger,
      },
    );

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 10 }),
    );
  });

  it('enables waitForOperatorExit when interactive TTY without --no-wait', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand('https://github.com/org/repo/issues/1', baseOptions, {
      isOperatorInputInteractive: () => true,
      isOperatorInputTty: () => true,
      runIssueSession,
      loadProfile,
      SessionLogger,
    });

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        waitForOperatorExit: true,
        onPostLoopWait: expect.any(Function),
      }),
    );
  });

  it('does not enable waitForOperatorExit when interactive via env but non-TTY', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand('https://github.com/org/repo/issues/1', baseOptions, {
      isOperatorInputInteractive: () => true,
      isOperatorInputTty: () => false,
      runIssueSession,
      loadProfile,
      SessionLogger,
    });

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bindOperatorInput: expect.any(Function),
        continueOnConductorError: true,
      }),
    );
    expect(runIssueSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        waitForOperatorExit: true,
      }),
    );
  });

  it('disables waitForOperatorExit when interactive TTY with --no-wait', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand(
      'https://github.com/org/repo/issues/1',
      { ...baseOptions, noWait: true },
      {
        isOperatorInputInteractive: () => true,
        isOperatorInputTty: () => true,
        runIssueSession,
        loadProfile,
        SessionLogger,
      },
    );

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        waitForOperatorExit: true,
      }),
    );
  });

  it('does not pass waitForOperatorExit when non-interactive', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));

    await executeIssueCommand('https://github.com/org/repo/issues/1', baseOptions, {
      isOperatorInputInteractive: () => false,
      runIssueSession,
      loadProfile,
      SessionLogger,
    });

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        waitForOperatorExit: true,
      }),
    );
  });
});
