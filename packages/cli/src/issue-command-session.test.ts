import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClose,
  mockCreate,
  mockFetchIssueContext,
  mockResolveGitHubAuthToken,
  mockSend,
  mockTuiCreate,
  mockTuiDispose,
} = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const mockFetchIssueContext = vi.fn();
  const mockResolveGitHubAuthToken = vi.fn();
  const mockTuiDispose = vi.fn();
  const mockTuiCreate = vi.fn(
    (_issueUrl: string, options?: { initialOperatorMessage?: string }) => ({
      bindOperatorInput: (api: { submit: (message: string) => boolean }) => {
        if (options?.initialOperatorMessage) {
          api.submit(options.initialOperatorMessage);
        }
        return () => {};
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
    mockFetchIssueContext,
    mockResolveGitHubAuthToken,
    mockSend,
    mockTuiCreate,
    mockTuiDispose,
  };
});

vi.mock('../../core/src/conductor/conductor-agent.js', () => ({
  ConductorAgent: {
    create: mockCreate,
    resume: mockCreate,
  },
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
    mockFetchIssueContext.mockReset();
    mockResolveGitHubAuthToken.mockReset();
    mockSend.mockReset();
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

    await executeIssueCommand(
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
