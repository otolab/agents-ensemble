import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import { createGitHubMonitor } from './github-monitor.js';
import type { GitHubClient } from './github-client.js';

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

    await vi.advanceTimersByTimeAsync(5000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].items).toHaveLength(1);

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
  });

  it('notifies offline diffs on first poll when sidecar cursor is restored', async () => {
    const client: GitHubClient = {
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
    vi.useFakeTimers();
  });

  it('emits structured monitor_error for phase failures', async () => {
    vi.useRealTimers();
    const onPollError = vi.fn();
    const githubClient: GitHubClient = {
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
});
