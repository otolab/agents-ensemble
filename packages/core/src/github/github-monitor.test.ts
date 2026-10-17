import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import { createGitHubMonitor } from './github-monitor.js';
import { GitHubApiError, type GitHubClient } from './github-client.js';

async function drainAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createCommentPollingClient(): {
  client: GitHubClient;
  getCommentPolls: () => number;
} {
  let commentPolls = 0;
  const client: GitHubClient = {
    getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
    getIssue: vi.fn(),
    listIssueComments: vi.fn(async () => {
      commentPolls++;
      const comments =
        commentPolls === 1
          ? [
              {
                id: 1,
                body: 'baseline',
                html_url: 'https://github.com/org/repo/issues/39#issuecomment-1',
                user: { login: 'op' },
                created_at: '2026-01-01T00:00:00Z',
              },
            ]
          : [
              {
                id: 1,
                body: 'baseline',
                html_url: 'https://github.com/org/repo/issues/39#issuecomment-1',
                user: { login: 'op' },
                created_at: '2026-01-01T00:00:00Z',
              },
              {
                id: 2,
                body: commentPolls === 2 ? 'hello' : 'second',
                html_url: 'https://github.com/org/repo/issues/39#issuecomment-2',
                user: { login: 'op' },
                created_at: '2026-01-02T00:00:00Z',
              },
            ];
      return comments;
    }),
    searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
    listPullRequestReviews: vi.fn().mockResolvedValue([]),
    listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
    getStatusCheckRollup: vi.fn().mockResolvedValue([]),
  };

  return {
    client,
    getCommentPolls: () => commentPolls,
  };
}

describe('createGitHubMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces updates before notifying conductor', async () => {
    const { client, getCommentPolls } = createCommentPollingClient();
    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      debounceMs: 5000,
      pollIntervalMs: 1000,
      githubClient: client,
      onUpdate,
    });

    monitor.start();
    await drainAsync();
    expect(getCommentPolls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await drainAsync();
    expect(getCommentPolls()).toBe(2);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(monitor.getCursor().pendingUpdates).toMatchObject([
      { id: 'issue-comment:2', kind: 'issue.comment' },
    ]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].items).toHaveLength(1);
    monitor.acknowledgeUpdates(['issue-comment:2']);
    expect(monitor.getCursor().pendingUpdates).toBeUndefined();

    await monitor.stop();
  });

  it('re-delivers persisted pending updates on resume until acknowledged', async () => {
    const pendingUpdate = {
      id: 'issue-comment:101',
      kind: 'issue.comment' as const,
      summary: 'saved before close',
      bodyPreview: 'saved before close',
    };
    const onUpdate = vi.fn();
    const onCursorChange = vi.fn();
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn().mockResolvedValue([]),
    };
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      cursor: {
        lastIssueCommentId: '101',
        pullRequests: {},
        pendingUpdates: [pendingUpdate],
      },
      debounceMs: 100,
      pollIntervalMs: 60_000,
      githubClient: client,
      onUpdate,
      onCursorChange,
    });

    monitor.start();
    await drainAsync();
    expect(monitor.getCursor().pendingUpdates).toEqual([pendingUpdate]);

    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]![0].items).toEqual([pendingUpdate]);

    monitor.acknowledgeUpdates([pendingUpdate.id]);
    expect(monitor.getCursor().pendingUpdates).toBeUndefined();
    expect(onCursorChange).toHaveBeenCalledWith(
      expect.objectContaining({ lastIssueCommentId: '101' }),
    );
    await monitor.stop();
  });

  it('flushes pending updates on stop', async () => {
    const { client } = createCommentPollingClient();
    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      debounceMs: 60_000,
      pollIntervalMs: 1000,
      githubClient: client,
      onUpdate,
    });

    monitor.start();
    await drainAsync();
    await vi.advanceTimersByTimeAsync(1000);
    await drainAsync();
    await monitor.stop();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(monitor.getCursor().pendingUpdates).toMatchObject([
      { id: 'issue-comment:2', kind: 'issue.comment' },
    ]);
  });

  it('polls a runtime-registered PR immediately', async () => {
    const listPullRequestReviews = vi.fn().mockResolvedValue([]);
    const listPullRequestReviewComments = vi.fn().mockResolvedValue([]);
    const getStatusCheckRollup = vi.fn().mockResolvedValue([]);
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews,
      listPullRequestReviewComments,
      getStatusCheckRollup,
    };
    const onCursorChange = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      pollIntervalMs: 1000,
      githubClient: client,
      onCursorChange,
      onUpdate: vi.fn(),
    });

    monitor.start();
    await drainAsync();
    expect(listPullRequestReviews).not.toHaveBeenCalled();

    monitor.registerPullRequest({
      prNumber: 354,
      registeredAt: '2026-09-07T05:00:00.000Z',
      kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
    });
    expect(monitor.getCursor().explicitPullRequests?.['354']).toMatchObject({
      registeredAt: '2026-09-07T05:00:00.000Z',
    });

    await vi.advanceTimersByTimeAsync(0);
    await drainAsync();

    expect(listPullRequestReviews).toHaveBeenCalledWith('org', 'repo', 354);
    expect(listPullRequestReviewComments).toHaveBeenCalledWith(
      'org',
      'repo',
      354,
    );
    expect(getStatusCheckRollup).toHaveBeenCalledWith('org', 'repo', 354);
    expect(onCursorChange).toHaveBeenCalled();

    await monitor.stop();
  });

  it('stops polling an unregistered explicit-only PR and preserves its cursor', async () => {
    const listPullRequestReviews = vi.fn().mockResolvedValue([]);
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews,
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn().mockResolvedValue([]),
    };
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      cursor: {
        pullRequests: { '354': { lastReviewId: '10' } },
        explicitPullRequests: {
          '354': { registeredAt: '2026-09-07T05:00:00.000Z' },
        },
      },
      pollIntervalMs: 1000,
      githubClient: client,
      onUpdate: vi.fn(),
    });

    monitor.start();
    await drainAsync();
    expect(listPullRequestReviews).toHaveBeenCalledTimes(1);

    monitor.unregisterPullRequest(354);
    expect(monitor.getCursor().explicitPullRequests).toEqual({});
    expect(monitor.getCursor().pullRequests?.['354']).toMatchObject({
      lastReviewId: '10',
    });

    await vi.advanceTimersByTimeAsync(1000);
    await drainAsync();
    expect(listPullRequestReviews).toHaveBeenCalledTimes(1);
    expect(monitor.getCursor().explicitPullRequests).toEqual({});
    expect(monitor.getCursor().pullRequests?.['354']).toMatchObject({
      lastReviewId: '10',
    });

    await monitor.stop();
  });

  it('retries a failed registration bootstrap and emits later CI completion', async () => {
    let statusPolls = 0;
    const onUpdate = vi.fn();
    const onPollError = vi.fn();
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn(async () => {
        statusPolls += 1;
        if (statusPolls === 1) {
          throw new Error('temporary status API failure');
        }
        if (statusPolls === 2) {
          return [
            {
              __typename: 'CheckRun',
              id: 'check-run-1',
              name: 'ci/test',
              status: 'IN_PROGRESS',
              conclusion: null,
              headSha: 'sha-1',
            },
          ];
        }
        return [
          {
            __typename: 'CheckRun',
            id: 'check-run-1',
            name: 'ci/test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headSha: 'sha-1',
          },
        ];
      }),
    };
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      debounceMs: 0,
      pollIntervalMs: 1000,
      activePollIntervalMs: 1000,
      githubClient: client,
      onUpdate,
      onPollError,
    });

    monitor.start();
    await drainAsync();
    monitor.registerPullRequest({
      prNumber: 354,
      registeredAt: '2026-09-07T05:00:00.000Z',
      kinds: ['ci.completed'],
    });

    await vi.advanceTimersByTimeAsync(0);
    await drainAsync();
    expect(statusPolls).toBe(1);
    expect(onPollError).toHaveBeenCalledTimes(1);
    expect(monitor.getCursor().pullRequests?.['354']).toMatchObject({
      ciBootstrapPending: true,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await drainAsync();
    expect(statusPolls).toBe(2);
    expect(monitor.getCursor().pullRequests?.['354']).toMatchObject({
      lastAggregateBySha: {
        'sha-1': 'running',
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await drainAsync();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusPolls).toBe(3);
    monitor.flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].items).toMatchObject([
      expect.objectContaining({
        kind: 'ci.completed',
        commitSha: 'sha-1',
        aggregateState: 'completed',
      }),
    ]);

    await monitor.stop();
  });

  it('notifies offline diffs on first poll when sidecar cursor is restored', async () => {
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 100,
          body: 'seen before stop',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-100',
          user: { login: 'op' },
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 101,
          body: 'arrived while session was down',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-101',
          user: { login: 'op' },
          created_at: '2026-01-02T00:00:00Z',
        },
      ]),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn().mockResolvedValue([]),
    };

    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      cursor: { lastIssueCommentId: '100', pullRequests: {} },
      debounceMs: 100,
      pollIntervalMs: 60_000,
      githubClient: client,
      onUpdate,
    });

    monitor.start();
    await drainAsync();
    expect(client.listIssueComments).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].items[0]).toMatchObject({
      id: 'issue-comment:101',
      kind: 'issue.comment',
    });

    await monitor.stop();
  });

  it('aborts in-flight poll when stop exceeds stopPollWaitMs', async () => {
    vi.useRealTimers();
    let pollResolve: (() => void) | undefined;
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn(
        () =>
          new Promise((resolve) => {
            pollResolve = () =>
              resolve([
                {
                  id: 1,
                  body: 'baseline',
                  html_url: 'https://github.com/org/repo/issues/39#issuecomment-1',
                  user: { login: 'op' },
                  created_at: '2026-01-01T00:00:00Z',
                },
              ]);
          }),
      ),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn().mockResolvedValue([]),
    };

    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      cursor: { lastIssueCommentId: '0', pullRequests: {} },
      debounceMs: 60_000,
      pollIntervalMs: 60_000,
      stopPollWaitMs: 50,
      githubClient: client,
      onUpdate,
    });

    monitor.start();
    await drainAsync();
    expect(client.listIssueComments).toHaveBeenCalledTimes(1);

    const stopPromise = monitor.stop();
    await stopPromise;

    expect(client.listIssueComments).toHaveBeenCalledTimes(1);
    pollResolve?.();
    await drainAsync();
    expect(monitor.getCursor()).toMatchObject({
      lastIssueCommentId: '0',
      pendingUpdates: undefined,
    });
    expect(onUpdate).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });

  it('emits structured monitor_error for phase failures', async () => {
    vi.useRealTimers();
    const onPollError = vi.fn();
    const githubClient: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([
        {
          number: 42,
          title: 'feat',
          url: 'https://github.com/org/repo/pull/42',
          state: 'OPEN',
        },
      ]),
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn().mockRejectedValue(new TypeError('parse failed')),
    };
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      cursor: { lastIssueCommentId: '1', pullRequests: {} },
      debounceMs: 60_000,
      pollIntervalMs: 60_000,
      githubClient,
      onUpdate: vi.fn(),
      onPollError,
    });

    monitor.start();
    await vi.waitFor(() => expect(onPollError).toHaveBeenCalled());

    const error = onPollError.mock.calls[0]![0];
    expect(error.phase).toBe('pr_status_checks');
    expect(error.prNumber).toBe(42);
    expect(error.cause).toBe('parse');

    await monitor.stop();
    vi.useFakeTimers();
  });

  it('coalesces repeated retryable failures and reports recovery after a clean poll', async () => {
    let issueCommentPolls = 0;
    let successfulPollAt: number | undefined;
    const onPollError = vi.fn();
    const onPollRecovered = vi.fn();
    const onUpdate = vi.fn();
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn(async () => {
        issueCommentPolls += 1;
        if (issueCommentPolls <= 12) {
          throw new TypeError('fetch failed');
        }
        successfulPollAt = Date.now();
        return [
          {
            id: 1,
            body: 'baseline',
            html_url: 'https://github.com/org/repo/issues/39#issuecomment-1',
            user: { login: 'op' },
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 2,
            body: 'new comment',
            html_url: 'https://github.com/org/repo/issues/39#issuecomment-2',
            user: { login: 'op' },
            created_at: '2026-01-02T00:00:00Z',
          },
        ];
      }),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn().mockResolvedValue([]),
    };
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      cursor: { lastIssueCommentId: '1', pullRequests: {} },
      debounceMs: 5000,
      pollIntervalMs: 1000,
      githubClient: client,
      onUpdate,
      onPollError,
      onPollRecovered,
    });

    monitor.start();
    await vi.waitFor(() => expect(onPollError).toHaveBeenCalledTimes(1));
    expect(issueCommentPolls).toBe(1);
    expect(onPollError.mock.calls[0]![0]).toMatchObject({
      phase: 'issue_comments',
      cause: 'network',
      retryable: true,
      message: 'fetch failed',
    });

    await vi.advanceTimersByTimeAsync(12_000);
    expect(issueCommentPolls).toBe(13);
    expect(onPollError).toHaveBeenCalledTimes(1);
    expect(onPollRecovered).toHaveBeenCalledOnce();
    expect(onPollRecovered).toHaveBeenCalledWith(11);
    expect(monitor.getCursor().lastIssueCommentId).toBe('2');
    expect(onUpdate).not.toHaveBeenCalled();

    const debounceRemaining = 5000 - (Date.now() - successfulPollAt!);
    expect(debounceRemaining).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(debounceRemaining - 1);
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]![0].items).toMatchObject([
      expect.objectContaining({
        id: 'issue-comment:2',
        bodyPreview: 'new comment',
      }),
    ]);

    await monitor.stop();
  });

  it('continues to report non-retryable authentication errors on each poll', async () => {
    const onPollError = vi.fn();
    const client: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi
        .fn()
        .mockRejectedValue(
          new GitHubApiError('GitHub API 401: Bad credentials', { status: 401 }),
        ),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
      getStatusCheckRollup: vi.fn().mockResolvedValue([]),
    };
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      cursor: { lastIssueCommentId: '1', pullRequests: {} },
      pollIntervalMs: 1000,
      githubClient: client,
      onUpdate: vi.fn(),
      onPollError,
    });

    monitor.start();
    await vi.waitFor(() => expect(onPollError).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2000);

    expect(onPollError).toHaveBeenCalledTimes(3);
    for (const [error] of onPollError.mock.calls) {
      expect(error).toMatchObject({
        cause: 'auth',
        retryable: false,
      });
      expect(error.message).toContain('[github-auth]');
    }

    await monitor.stop();
  });
});
