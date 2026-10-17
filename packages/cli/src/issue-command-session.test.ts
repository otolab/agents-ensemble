import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClose,
  mockCreate,
  mockCreateCursorSdkConductorAgentFactory,
  mockCreateGitHubMonitor,
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
  const mockCreateGitHubMonitor = vi.fn();
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
    mockCreateGitHubMonitor,
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

vi.mock('../../core/src/github/github-monitor.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../core/src/github/github-monitor.js')>();
  return {
    ...original,
    createGitHubMonitor: mockCreateGitHubMonitor,
  };
});

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

import { executeIssueCommand, issueCommandExitCode } from './issue-command.js';
import type { AcpBridge } from '../../core/src/acp/acp-bridge.js';
import { DEFAULT_ENSEMBLE_CONFIG } from '../../core/src/config/defaults.js';
import { runIssueSession as runIssueSessionImpl } from '../../core/src/conductor/issue-session.js';
import { runGit } from '../../core/src/git/run-git.js';
import {
  loadSessionSidecar,
  sessionSidecarPath,
} from '../../core/src/session/session-sidecar.js';
import * as worktreeModule from '../../core/src/worktree/worktree.js';

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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('executeIssueCommand with the core session', () => {
  beforeEach(() => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReset();
    mockCreateGitHubMonitor.mockReset();
    mockCreateGitHubMonitor.mockImplementation((options) => {
      const cursor = structuredClone(
        options.cursor ?? { pullRequests: {}, explicitPullRequests: {} },
      );
      return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn(),
        getCursor: vi.fn(() => cursor),
        acknowledgeUpdates: vi.fn(),
        registerPullRequest: vi.fn(),
        unregisterPullRequest: vi.fn(),
      };
    });
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
    vi.restoreAllMocks();
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

  it('closes a TTY session and resumes it from the sidecar with --continue', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    let resolveInFlightGithubSend!: (result: {
      runId: string;
      status: string;
      result: string;
    }) => void;
    const inFlightGithubSend = new Promise<{
      runId: string;
      status: string;
      result: string;
    }>((resolve) => {
      resolveInFlightGithubSend = resolve;
    });
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      })
      .mockReturnValueOnce(inFlightGithubSend);
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));
    await runGit(['init'], repoRoot);
    await runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    await runGit(['config', 'user.name', 'test'], repoRoot);
    await runGit(['commit', '--allow-empty', '-m', 'init'], repoRoot);
    const options = {
      repoRoot,
      conductorCwd: repoRoot,
      worktree: 'isolated' as const,
    };
    const deps = {
      isOperatorInputInteractive: (message: string | undefined) =>
        message === undefined,
      isOperatorInputTty: () => true,
      runIssueSession: runIssueSessionImpl,
    };
    const pendingUpdate = {
      id: 'issue-comment:42',
      kind: 'issue.comment' as const,
      summary: 'arrived while the TTY session was closing',
      bodyPreview: 'arrived while the TTY session was closing',
    };
    const closeAcknowledge = vi.fn();
    let resumeAcknowledge: ReturnType<typeof vi.fn> | undefined;
    mockCreateGitHubMonitor
      .mockImplementationOnce((monitorOptions) => {
        let cursor = structuredClone(
          monitorOptions.cursor ?? {
            pullRequests: {},
            explicitPullRequests: {},
          },
        );
        return {
          start: vi.fn(() => {
            cursor = {
              ...cursor,
              lastIssueCommentId: '42',
              pendingUpdates: [pendingUpdate],
            };
            monitorOptions.onCursorChange?.(cursor);
            monitorOptions.onUpdate({ items: [pendingUpdate] });
          }),
          stop: vi.fn().mockResolvedValue(undefined),
          flush: vi.fn(),
          getCursor: vi.fn(() => cursor),
          acknowledgeUpdates: closeAcknowledge,
          registerPullRequest: vi.fn(),
          unregisterPullRequest: vi.fn(),
        };
      })
      .mockImplementationOnce((monitorOptions) => {
        let cursor = structuredClone(monitorOptions.cursor!);
        const acknowledgeUpdates = vi.fn((ids: readonly string[]) => {
          const acknowledged = new Set(ids);
          const pendingUpdates = (cursor.pendingUpdates ?? []).filter(
            (item) => !acknowledged.has(item.id),
          );
          cursor = {
            ...cursor,
            ...(pendingUpdates.length > 0 ? { pendingUpdates } : {}),
          };
          if (pendingUpdates.length === 0) {
            delete cursor.pendingUpdates;
          }
          monitorOptions.onCursorChange?.(cursor);
        });
        resumeAcknowledge = acknowledgeUpdates;
        return {
          start: vi.fn(() => {
            monitorOptions.onUpdate({
              items: cursor.pendingUpdates ?? [],
            });
          }),
          stop: vi.fn().mockResolvedValue(undefined),
          flush: vi.fn(),
          getCursor: vi.fn(() => cursor),
          acknowledgeUpdates,
          registerPullRequest: vi.fn(),
          unregisterPullRequest: vi.fn(),
        };
      });

    const closePromise = executeIssueCommand(issueUrl, options, deps);
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(mockTuiOperatorApi.current).toBeDefined(),
    );
    mockTuiOperatorApi.current!.submit('/close');
    resolveInFlightGithubSend({
      runId: 'run-2',
      status: 'finished',
      result: 'done',
    });
    const closeResult = await withTimeout(closePromise, 'TTY /close');

    expect(closeResult.stopReason).toBe('completed');
    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockTuiDispose).toHaveBeenCalledOnce();
    const closedTui = mockTuiCreate.mock.results[0]?.value as {
      telemetrySink: ReturnType<typeof vi.fn>;
    };
    expect(closedTui.telemetrySink).toHaveBeenCalledWith({
      type: 'session.operator_close',
    });
    const sidecarPath = join(
      repoRoot,
      '.ensemble',
      'sessions',
      'agent-test.json',
    );
    const closeSidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
    expect(closeSidecar.githubMonitor.pendingUpdates).toEqual([pendingUpdate]);
    expect(closeAcknowledge).not.toHaveBeenCalled();

    const continuePromise = executeIssueCommand(
      issueUrl,
      { ...options, continue: true },
      deps,
    );
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(resumeAcknowledge).toHaveBeenCalledWith([pendingUpdate.id]),
    );
    await vi.waitFor(() =>
      expect(mockTuiOperatorApi.current).toBeDefined(),
    );

    expect(mockCreate.mock.calls[1]?.[0]).toBe('agent-test');
    const resumedTui = mockTuiCreate.mock.results[1]?.value as {
      telemetrySink: ReturnType<typeof vi.fn>;
    };
    expect(resumedTui.telemetrySink).toHaveBeenCalledWith({
      type: 'session.continue',
      conductorAgentId: 'agent-test',
    });

    mockTuiOperatorApi.current!.submit('/close');
    const continueResult = await withTimeout(
      continuePromise,
      'TTY --continue session',
    );

    expect(continueResult.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockSend.mock.calls[2]?.[0]).toContain(
      'arrived while the TTY session was closing',
    );
    expect(mockClose).toHaveBeenCalledTimes(2);
    expect(mockTuiDispose).toHaveBeenCalledTimes(2);
    const continuedSidecar = JSON.parse(
      await readFile(sidecarPath, 'utf8'),
    );
    expect(continuedSidecar.githubMonitor.pendingUpdates).toBeUndefined();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('continues the same worker ACP session after /close interrupts its first prompt', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));
    const userEnsembleRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-cli-session-user-'),
    );
    await runGit(['init'], repoRoot);
    await runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    await runGit(['config', 'user.name', 'test'], repoRoot);
    await runGit(['commit', '--allow-empty', '-m', 'init'], repoRoot);

    const worktreePath = join(repoRoot, '.ensemble', 'worktrees', 'issue-1');
    const firstPrompt = createDeferred<{
      stopReason: string;
      responseText: string;
    }>();
    const firstBridge = {
      newSession: vi.fn().mockResolvedValue('worker-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn(() => firstPrompt.promise),
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const resumedBridge = {
      newSession: vi.fn().mockResolvedValue('unexpected-new-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn().mockResolvedValue({
        stopReason: 'end_turn',
        responseText: 'worker resumed after close',
      }),
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const connectAcp = vi
      .fn()
      .mockResolvedValueOnce(firstBridge)
      .mockResolvedValueOnce(resumedBridge);
    const options = {
      repoRoot,
      conductorCwd: repoRoot,
      worktree: 'isolated',
      githubMonitor: false,
      defaultAcpCommand: process.execPath,
    };
    const deps = {
      isOperatorInputInteractive: () => true,
      isOperatorInputTty: () => true,
      loadEnsembleConfig: async () => structuredClone(DEFAULT_ENSEMBLE_CONFIG),
      loadProfile: async () => ({
        profile: {
          workers: [{ name: 'implementer', kind: 'implementer' }],
        },
        profilePath: '/tmp/profile.yaml',
      }),
      runIssueSession: (
        sessionOptions: Parameters<typeof runIssueSessionImpl>[0],
      ) =>
        runIssueSessionImpl({
          ...sessionOptions,
          connectAcp,
          disableGitHubMonitor: true,
          mcpConfigOptions: { userEnsembleRoot },
          registerProcessSignalHandlers: false,
        }),
    };

    try {
      const closePromise = executeIssueCommand(issueUrl, options, deps);
      await vi.waitFor(() =>
        expect(firstBridge.promptSession).toHaveBeenCalledOnce(),
      );
      await vi.waitFor(() =>
        expect(mockTuiOperatorApi.current).toBeDefined(),
      );
      expect(mockTuiOperatorApi.current!.submit('/close')).toBe(false);
      const closeResult = await withTimeout(closePromise, 'worker /close');

      expect(closeResult.stopReason).toBe('completed');
      expect(firstBridge.cancelSession).toHaveBeenCalledWith('worker-session');
      expect(firstBridge.close).toHaveBeenCalledOnce();
      await expect(access(worktreePath)).resolves.toBeUndefined();
      await expect(
        loadSessionSidecar(
          sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
        ),
      ).resolves.toMatchObject({
        workers: {
          implementer: {
            acpSessionId: 'worker-session',
            acpCwd: worktreePath,
          },
        },
      });

      firstPrompt.resolve({ stopReason: 'cancelled', responseText: '' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const sendsBeforeContinue = mockSend.mock.calls.length;
      const continuePromise = executeIssueCommand(
        issueUrl,
        { ...options, continue: true },
        deps,
      );
      await vi.waitFor(() =>
        expect(resumedBridge.loadSession).toHaveBeenCalledWith(
          'worker-session',
          worktreePath,
          expect.any(Function),
        ),
      );
      await vi.waitFor(() =>
        expect(mockSend).toHaveBeenCalledTimes(sendsBeforeContinue + 1),
      );
      expect(connectAcp).toHaveBeenCalledTimes(2);
      expect(connectAcp.mock.calls[1]?.[0].cwd).toBe(worktreePath);
      expect(resumedBridge.newSession).not.toHaveBeenCalled();
      expect(resumedBridge.promptSession).toHaveBeenCalledWith(
        'worker-session',
        expect.stringContaining('前回の続きです'),
        expect.any(Object),
      );
      expect(String(mockSend.mock.calls[sendsBeforeContinue]?.[0])).toContain(
        'worker resumed after close',
      );
      expect(mockTuiOperatorApi.current).toBeDefined();
      expect(mockTuiOperatorApi.current!.submit('/close')).toBe(false);
      const continueResult = await withTimeout(
        continuePromise,
        'worker --continue',
      );

      expect(continueResult.stopReason).toBe('completed');
      expect(resumedBridge.close).toHaveBeenCalledOnce();
      await expect(access(worktreePath)).resolves.toBeUndefined();
    } finally {
      firstPrompt.resolve({ stopReason: 'cancelled', responseText: '' });
      await rm(repoRoot, { recursive: true, force: true });
      await rm(userEnsembleRoot, { recursive: true, force: true });
    }
  });

  it('keeps /exit worktree cleanup failures warning-only with exit code 0', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-session-'));
    const path = join(repoRoot, '.ensemble', 'worktrees', 'issue-1');
    const removeSpy = vi
      .spyOn(worktreeModule, 'removeWorkerWorktree')
      .mockResolvedValue({
        status: 'failed',
        path,
        branch: 'ensemble/issue-1',
        error: 'git worktree remove failed: lock held',
      });

    const sessionPromise = executeIssueCommand(
      issueUrl,
      {
        repoRoot,
        conductorCwd: repoRoot,
        worktree: 'isolated',
        githubMonitor: false,
      },
      {
        isOperatorInputInteractive: (message) => message === undefined,
        isOperatorInputTty: () => true,
        runIssueSession: (sessionOptions) =>
          runIssueSessionImpl({
            ...sessionOptions,
            workerWorktree: {
              path,
              branch: 'ensemble/issue-1',
              issue: {
                owner: 'org',
                repo: 'repo',
                number: 1,
                url: issueUrl,
              },
            },
          }),
      },
    );
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(mockTuiOperatorApi.current).toBeDefined(),
    );
    mockTuiOperatorApi.current!.submit('/exit');
    const result = await withTimeout(sessionPromise, 'TTY /exit cleanup failure');

    expect(result.stopReason).toBe('completed');
    expect(issueCommandExitCode(result)).toBe(0);
    expect(removeSpy).toHaveBeenCalledOnce();
    const tui = mockTuiCreate.mock.results[0]?.value as {
      telemetrySink: ReturnType<typeof vi.fn>;
    };
    expect(tui.telemetrySink).toHaveBeenCalledWith({
      type: 'harness.worktree.remove_failed',
      path,
      branch: 'ensemble/issue-1',
      error: 'git worktree remove failed: lock held',
    });
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
