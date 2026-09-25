import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClose,
  mockCreate,
  mockCreateCursorSdkConductorAgentFactory,
  mockFetchIssueContext,
  mockResolveGitHubAuthToken,
  mockSend,
  mockTuiOperatorApi,
  mockTuiCreate,
  mockTuiDispose,
} = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const mockCreateCursorSdkConductorAgentFactory = vi.fn();
  const mockFetchIssueContext = vi.fn();
  const mockResolveGitHubAuthToken = vi.fn();
  const mockTuiDispose = vi.fn();
  const mockTuiOperatorApi = {
    current: undefined as { submit: (message: string) => boolean } | undefined,
  };
  const mockTuiCreate = vi.fn(
    (_issueUrl: string, options?: { initialOperatorMessage?: string }) => ({
      bindOperatorInput: (api: { submit: (message: string) => boolean }) => {
        // Match the production binding lifecycle: register the API before
        // dispatching the optional initial message, then keep it until dispose.
        mockTuiOperatorApi.current = api;
        const initialOperatorMessage =
          options?.initialOperatorMessage ??
          (process.env.ENSEMBLE_OPERATOR_MESSAGE?.trim() || undefined);
        if (initialOperatorMessage) {
          api.submit(initialOperatorMessage);
        }
        return () => {
          if (mockTuiOperatorApi.current === api) {
            mockTuiOperatorApi.current = undefined;
          }
        };
      },
      displayBackend: { render: vi.fn() },
      telemetrySink: vi.fn(),
      notifyReprompt: vi.fn(),
      dispose: mockTuiDispose,
    }),
  );
  return {
    mockClose,
    mockCreate,
    mockCreateCursorSdkConductorAgentFactory,
    mockFetchIssueContext,
    mockResolveGitHubAuthToken,
    mockSend,
    mockTuiOperatorApi,
    mockTuiCreate,
    mockTuiDispose,
  };
});

vi.mock('../../core/src/conductor/cursor-sdk-conductor-agent.js', () => ({
  createCursorSdkConductorAgentFactory: mockCreateCursorSdkConductorAgentFactory,
}));

vi.mock('../../core/src/github/issue-context.js', () => ({
  fetchIssueContext: mockFetchIssueContext,
}));

vi.mock('../../core/src/github/resolve-github-auth-token.js', () => ({
  resolveGitHubAuthToken: mockResolveGitHubAuthToken,
}));

vi.mock('@agents-ensemble/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agents-ensemble/core')>();
  return {
    ...actual,
    loadEnsembleConfig: vi.fn(async () => actual.DEFAULT_ENSEMBLE_CONFIG),
    loadProfile: vi.fn(async () => ({
      profile: { workers: [] },
      profilePath: '/tmp/profile.yaml',
    })),
  };
});

vi.mock('./tui/create-issue-session-tui-host.js', () => ({
  createIssueSessionTuiHost: mockTuiCreate,
}));

import { executeIssueCommand } from './issue-command.js';
import { runIssueSession as runIssueSessionImpl } from '../../core/src/conductor/issue-session.js';

const issueUrl = 'https://github.com/org/repo/issues/1';

function defaultConductorUsage() {
  return {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    runs: [],
  };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe('executeIssueCommand with the core session', () => {
  beforeEach(() => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReturnValue({
      create: mockCreate,
      resume: mockCreate,
    });
    mockFetchIssueContext.mockReset();
    mockResolveGitHubAuthToken.mockReset();
    mockSend.mockReset();
    mockTuiOperatorApi.current = undefined;
    mockTuiCreate.mockClear();
    mockTuiDispose.mockClear();

    mockCreate.mockImplementation(async () => ({
      agentId: 'agent-test',
      send: mockSend,
      close: mockClose,
      getUsage: vi.fn().mockResolvedValue(defaultConductorUsage()),
    }));
    mockFetchIssueContext.mockResolvedValue({
      issue: { owner: 'org', repo: 'repo', number: 1, url: issueUrl },
      title: 'Test issue',
      body: 'Test issue body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    mockResolveGitHubAuthToken.mockResolvedValue({
      token: 'test-github-token',
      source: 'GITHUB_TOKEN',
    });
  });

  afterEach(() => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
  });

  it.each([
    { label: 'non-TTY', tty: false },
    { label: 'TTY', tty: true },
  ])('sends the CLI message through the first operator turn on $label', async ({ tty }) => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));

    const sessionPromise = executeIssueCommand(
      issueUrl,
      {
        repoRoot,
        conductorCwd: repoRoot,
        worktree: 'in_repo',
        githubMonitor: false,
        initialOperatorMessage: 'from cli',
      },
      {
        isOperatorInputInteractive: (message) => Boolean(message),
        isOperatorInputTty: () => tty,
        runIssueSession: runIssueSessionImpl,
      },
    );

    if (tty) {
      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(mockTuiOperatorApi.current).toBeDefined());
      mockTuiOperatorApi.current!.submit('/exit');
    }
    await sessionPromise;

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(String(mockSend.mock.calls[0]?.[0])).toContain('Test issue body');
    expect(mockSend.mock.calls[1]?.[0]).toBe('from cli');
    if (tty) {
      expect(mockTuiCreate).toHaveBeenCalledWith(
        issueUrl,
        expect.objectContaining({ initialOperatorMessage: 'from cli' }),
      );
    }
  });

  it('keeps a plain TTY session in post-loop wait until /exit', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));

    let operatorApi: { submit: (message: string) => boolean } | undefined;
    const telemetryEventTypes: string[] = [];

    mockTuiCreate.mockImplementationOnce(() => ({
      bindOperatorInput: (api: { submit: (message: string) => boolean }) => {
        operatorApi = api;
        return () => {};
      },
      displayBackend: { render: vi.fn() },
      telemetrySink: (event: { type: string }) => {
        telemetryEventTypes.push(event.type);
        if (event.type === 'session.post_loop_wait') {
          operatorApi!.submit('/exit');
        }
      },
      notifyReprompt: vi.fn(),
      dispose: mockTuiDispose,
    }));

    const result = await withTimeout(
      executeIssueCommand(
        issueUrl,
        {
          repoRoot,
          conductorCwd: repoRoot,
          worktree: 'in_repo',
          githubMonitor: false,
        },
        {
          isOperatorInputInteractive: (message) => message === undefined,
          isOperatorInputTty: () => true,
          runIssueSession: runIssueSessionImpl,
        },
      ),
      'plain TTY post-loop session',
    );

    expect(result.stopReason).toBe('completed');
    expect(mockTuiCreate).toHaveBeenCalledWith(
      issueUrl,
      expect.objectContaining({ initialOperatorMessage: undefined }),
    );
    expect(mockSend).toHaveBeenCalledOnce();
    expect(telemetryEventTypes.indexOf('session.post_loop_wait')).toBeGreaterThanOrEqual(0);
    expect(telemetryEventTypes.indexOf('session.stop')).toBeGreaterThan(
      telemetryEventTypes.indexOf('session.post_loop_wait'),
    );
  });

  it('keeps a TTY CLI-message session in post-loop wait until /exit', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));

    const sessionPromise = executeIssueCommand(
      issueUrl,
      {
        repoRoot,
        conductorCwd: repoRoot,
        worktree: 'in_repo',
        githubMonitor: false,
        initialOperatorMessage: 'from cli',
      },
      {
        isOperatorInputInteractive: () => true,
        isOperatorInputTty: () => true,
        runIssueSession: runIssueSessionImpl,
      },
    );

    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    const tuiHost = mockTuiCreate.mock.results[0]?.value as {
      telemetrySink: ReturnType<typeof vi.fn>;
    };
    await vi.waitFor(() =>
      expect(tuiHost.telemetrySink).toHaveBeenCalledWith({
        type: 'session.post_loop_wait',
      }),
    );

    let settled = false;
    void sessionPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(mockTuiOperatorApi.current).toBeDefined();

    mockTuiOperatorApi.current!.submit('follow-up from cli');
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(3));
    expect(mockSend.mock.calls[2]?.[0]).toBe('follow-up from cli');

    mockTuiOperatorApi.current!.submit('/exit');
    const result = await withTimeout(sessionPromise, 'TTY CLI-message session');

    expect(result.stopReason).toBe('completed');
    expect(mockSend.mock.calls[1]?.[0]).toBe('from cli');
    expect(tuiHost.telemetrySink).toHaveBeenCalledWith({
      type: 'session.operator_exit',
    });
    expect(tuiHost.telemetrySink).toHaveBeenCalledWith({
      type: 'session.stop',
      stopReason: 'completed',
    });
  });

  it('keeps a TTY environment-message session in post-loop wait until /exit', async () => {
    process.env.ENSEMBLE_OPERATOR_MESSAGE = 'from env';
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));

    const sessionPromise = executeIssueCommand(
      issueUrl,
      {
        repoRoot,
        conductorCwd: repoRoot,
        worktree: 'in_repo',
        githubMonitor: false,
      },
      {
        isOperatorInputInteractive: () => true,
        isOperatorInputTty: () => true,
        runIssueSession: runIssueSessionImpl,
      },
    );

    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    const tuiHost = mockTuiCreate.mock.results[0]?.value as {
      telemetrySink: ReturnType<typeof vi.fn>;
    };
    await vi.waitFor(() =>
      expect(tuiHost.telemetrySink).toHaveBeenCalledWith({
        type: 'session.post_loop_wait',
      }),
    );

    let settled = false;
    void sessionPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(mockTuiOperatorApi.current).toBeDefined();

    mockTuiOperatorApi.current!.submit('follow-up from env');
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(3));
    expect(mockSend.mock.calls[2]?.[0]).toBe('follow-up from env');

    mockTuiOperatorApi.current!.submit('/exit');
    const result = await withTimeout(sessionPromise, 'TTY environment-message session');

    expect(result.stopReason).toBe('completed');
    expect(mockSend.mock.calls[1]?.[0]).toBe('from env');
    expect(tuiHost.telemetrySink).toHaveBeenCalledWith({
      type: 'session.operator_exit',
    });
    expect(tuiHost.telemetrySink).toHaveBeenCalledWith({
      type: 'session.stop',
      stopReason: 'completed',
    });
  });

  it('stops on a one-shot conductor error instead of waiting for input', async () => {
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'briefing sent',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'error',
        error: { message: 'conductor failed' },
      });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));

    const result = await withTimeout(
      executeIssueCommand(
        issueUrl,
        {
          repoRoot,
          conductorCwd: repoRoot,
          worktree: 'in_repo',
          githubMonitor: false,
          initialOperatorMessage: 'from cli',
        },
        {
          isOperatorInputInteractive: (message) => Boolean(message),
          isOperatorInputTty: () => false,
          runIssueSession: runIssueSessionImpl,
        },
      ),
      'one-shot error session',
    );

    expect(result.stopReason).toBe('error');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]?.[0]).toBe('from cli');
  });

  it('stops on a one-shot ask_human question instead of waiting for input', async () => {
    let conductorTools: Record<string, { execute: (args: unknown) => Promise<unknown> }> = {};
    mockCreate.mockImplementation(async (options: {
      customTools?: Record<string, { execute: (args: unknown) => Promise<unknown> }>;
    }) => {
      conductorTools = options.customTools ?? {};
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: vi.fn().mockResolvedValue(defaultConductorUsage()),
      };
    });
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'briefing sent',
      })
      .mockImplementationOnce(async () => {
        await conductorTools.ask_human!.execute({ question: 'Should we continue?' });
        return {
          runId: 'run-2',
          status: 'finished',
          result: 'waiting for operator',
        };
      });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));

    const result = await withTimeout(
      executeIssueCommand(
        issueUrl,
        {
          repoRoot,
          conductorCwd: repoRoot,
          worktree: 'in_repo',
          githubMonitor: false,
          initialOperatorMessage: 'from cli',
        },
        {
          isOperatorInputInteractive: (message) => Boolean(message),
          isOperatorInputTty: () => false,
          runIssueSession: runIssueSessionImpl,
        },
      ),
      'one-shot ask_human session',
    );

    expect(result.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]?.[0]).toBe('from cli');
    expect(result.openQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question: 'Should we continue?',
          status: 'open',
        }),
      ]),
    );
  });
});
