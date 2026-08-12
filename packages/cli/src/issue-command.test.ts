import { describe, expect, it, vi } from 'vitest';

vi.mock('@agents-ensemble/core', () => ({
  loadProfile: vi.fn(),
  runIssueSession: vi.fn(),
  SessionLogger: vi.fn(),
}));

import { executeIssueCommand, resolveIssueSessionMaxTurns, resolveResumeAgentIdFromOptions } from './issue-command.js';

const baseOptions = {
  repoRoot: '/tmp/repo',
  conductorCwd: '/tmp/cwd',
  worktree: 'isolated',
};

const issueUrl = 'https://github.com/org/repo/issues/1';

describe('resolveResumeAgentIdFromOptions', () => {
  it('returns explicit --resume agent id', async () => {
    const result = await resolveResumeAgentIdFromOptions(
      { resume: 'agent-explicit' },
      { issueUrl, repoRoot: '/tmp/repo' },
    );
    expect(result).toBe('agent-explicit');
  });

  it('throws when --continue and --resume are both set', async () => {
    await expect(
      resolveResumeAgentIdFromOptions(
        { resume: 'agent-a', continue: true },
        { issueUrl, repoRoot: '/tmp/repo' },
      ),
    ).rejects.toThrow('Cannot use --continue and --resume together');
  });

  it('throws when --continue finds no sidecar', async () => {
    const findLatestSessionSidecarForIssue = vi.fn().mockResolvedValue(undefined);

    await expect(
      resolveResumeAgentIdFromOptions(
        { continue: true },
        { issueUrl, repoRoot: '/tmp/repo' },
        { findLatestSessionSidecarForIssue },
      ),
    ).rejects.toThrow(
      `No session sidecar found for issue ${issueUrl}. Start a new session without --continue.`,
    );

    expect(findLatestSessionSidecarForIssue).toHaveBeenCalledWith({
      repoRoot: '/tmp/repo',
      issueUrl,
    });
  });

  it('returns conductorAgentId from latest sidecar and logs to stderr', async () => {
    const findLatestSessionSidecarForIssue = vi.fn().mockResolvedValue({
      conductorAgentId: 'agent-latest',
    });
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await resolveResumeAgentIdFromOptions(
      { continue: true },
      { issueUrl, repoRoot: '/tmp/repo' },
      { findLatestSessionSidecarForIssue },
    );

    expect(result).toBe('agent-latest');
    expect(stderrSpy).toHaveBeenCalledWith(
      '[continue] resuming session: conductorAgentId=agent-latest',
    );
    stderrSpy.mockRestore();
  });

  it('returns undefined when neither --resume nor --continue is set', async () => {
    const result = await resolveResumeAgentIdFromOptions(
      {},
      { issueUrl, repoRoot: '/tmp/repo' },
    );
    expect(result).toBeUndefined();
  });
});

describe('executeIssueCommand --continue wiring', () => {
  it('passes resolved resumeAgentId from --continue to runIssueSession', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    }));
    const findLatestSessionSidecarForIssue = vi.fn().mockResolvedValue({
      conductorAgentId: 'agent-from-continue',
    });
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeIssueCommand(
      issueUrl,
      { ...baseOptions, continue: true },
      {
        isOperatorInputInteractive: () => false,
        runIssueSession,
        loadProfile,
        SessionLogger,
        findLatestSessionSidecarForIssue,
      },
    );

    expect(runIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeAgentId: 'agent-from-continue' }),
    );
    stderrSpy.mockRestore();
  });
});

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
