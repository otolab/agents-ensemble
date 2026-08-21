import { describe, expect, it, vi } from 'vitest';

const mockTuiHost = vi.hoisted(() => {
  const bindOperatorInput = vi.fn(() => () => {});
  const displayBackend = { render: vi.fn() };
  const telemetrySink = vi.fn();
  const notifyReprompt = vi.fn();
  const dispose = vi.fn();
  return {
    bindOperatorInput,
    displayBackend,
    telemetrySink,
    notifyReprompt,
    dispose,
    createIssueSessionTuiHost: vi.fn(() => ({
      bindOperatorInput,
      displayBackend,
      telemetrySink,
      notifyReprompt,
      dispose,
    })),
  };
});

vi.mock('@agents-ensemble/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agents-ensemble/core')>();
  return {
    ...actual,
    loadEnsembleConfig: vi.fn(async () => actual.DEFAULT_ENSEMBLE_CONFIG),
    loadProfile: vi.fn(),
    runIssueSession: vi.fn(),
    SessionLogger: vi.fn(),
  };
});

vi.mock('./tui/create-issue-session-tui-host.js', () => ({
  createIssueSessionTuiHost: mockTuiHost.createIssueSessionTuiHost,
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
    expect(result).toEqual({ resumeAgentId: 'agent-explicit' });
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

  it('returns conductorAgentId from latest sidecar when --continue is set', async () => {
    const findLatestSessionSidecarForIssue = vi.fn().mockResolvedValue({
      conductorAgentId: 'agent-latest',
    });

    const result = await resolveResumeAgentIdFromOptions(
      { continue: true },
      { issueUrl, repoRoot: '/tmp/repo' },
      { findLatestSessionSidecarForIssue },
    );

    expect(result).toEqual({
      resumeAgentId: 'agent-latest',
      continuedFromSidecar: 'agent-latest',
    });
    expect(findLatestSessionSidecarForIssue).toHaveBeenCalledWith({
      repoRoot: '/tmp/repo',
      issueUrl,
    });
  });

  it('returns undefined when neither --resume nor --continue is set', async () => {
    const result = await resolveResumeAgentIdFromOptions(
      {},
      { issueUrl, repoRoot: '/tmp/repo' },
    );
    expect(result).toEqual({});
  });
});

describe('executeIssueCommand --continue wiring', () => {
  it('passes resolved resumeAgentId from --continue to runIssueSession', async () => {
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const emit = vi.fn();
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
      emit,
    }));
    const findLatestSessionSidecarForIssue = vi.fn().mockResolvedValue({
      conductorAgentId: 'agent-from-continue',
    });

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
    expect(emit).toHaveBeenCalledWith({
      type: 'session.continue',
      conductorAgentId: 'agent-from-continue',
    });
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
    mockTuiHost.createIssueSessionTuiHost.mockClear();
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
      emit: vi.fn(),
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
        bindOperatorInput: mockTuiHost.bindOperatorInput,
      }),
    );
    expect(mockTuiHost.createIssueSessionTuiHost).toHaveBeenCalledTimes(1);
    expect(mockTuiHost.dispose).toHaveBeenCalledTimes(1);
    expect(runIssueSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onPostLoopWait: expect.any(Function),
      }),
    );
  });

  it('subscribes TUI telemetry sink instead of stderr harness/observation when TTY', async () => {
    mockTuiHost.createIssueSessionTuiHost.mockClear();
    const subscribe = vi.fn();
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe,
      emit: vi.fn(),
    }));

    await executeIssueCommand('https://github.com/org/repo/issues/1', baseOptions, {
      isOperatorInputInteractive: () => true,
      isOperatorInputTty: () => true,
      runIssueSession,
      loadProfile,
      SessionLogger,
    });

    expect(subscribe).toHaveBeenCalledWith(mockTuiHost.telemetrySink);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(
      subscribe.mock.calls.every(
        (call) =>
          call[0] === mockTuiHost.telemetrySink || typeof call[0] === 'function',
      ),
    ).toBe(true);
  });

  it('subscribes stderr harness and observation sinks when non-TTY interactive', async () => {
    mockTuiHost.createIssueSessionTuiHost.mockClear();
    const subscribe = vi.fn();
    const runIssueSession = vi.fn().mockResolvedValue({ stopReason: 'completed' });
    const loadProfile = vi.fn().mockResolvedValue({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe,
      emit: vi.fn(),
    }));

    await executeIssueCommand('https://github.com/org/repo/issues/1', baseOptions, {
      isOperatorInputInteractive: () => true,
      isOperatorInputTty: () => false,
      runIssueSession,
      loadProfile,
      SessionLogger,
    });

    expect(mockTuiHost.createIssueSessionTuiHost).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(subscribe.mock.calls.some((call) => call[0] === mockTuiHost.telemetrySink)).toBe(
      false,
    );
  });

  it('does not enable waitForOperatorExit when interactive via env but non-TTY', async () => {
    mockTuiHost.createIssueSessionTuiHost.mockClear();
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
    expect(mockTuiHost.createIssueSessionTuiHost).not.toHaveBeenCalled();
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
