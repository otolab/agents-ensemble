import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHubMonitor } from './github-monitor.js';

async function drainAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createGitHubMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces updates before notifying conductor', async () => {
    let commentPolls = 0;
    const runGhFn = vi.fn(async (args: string[]) => {
      if (args[0] === 'api' && args[1]?.includes('/comments')) {
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
                  body: 'hello',
                  html_url: 'https://github.com/org/repo/issues/39#issuecomment-2',
                  user: { login: 'op' },
                  created_at: '2026-01-02T00:00:00Z',
                },
              ];
        return JSON.stringify(comments);
      }
      if (args[0] === 'search') {
        return '[]';
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });

    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      debounceMs: 5000,
      pollIntervalMs: 1000,
      runGhFn,
      onUpdate,
    });

    monitor.start();
    await drainAsync();
    expect(commentPolls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await drainAsync();
    expect(commentPolls).toBe(2);
    expect(onUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].items).toHaveLength(1);

    await monitor.stop();
  });

  it('flushes pending updates on stop', async () => {
    let commentPolls = 0;
    const runGhFn = vi.fn(async (args: string[]) => {
      if (args[0] === 'api' && args[1]?.includes('/comments')) {
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
                  body: 'second',
                  html_url: 'https://github.com/org/repo/issues/39#issuecomment-2',
                  user: { login: 'op' },
                  created_at: '2026-01-02T00:00:00Z',
                },
              ];
        return JSON.stringify(comments);
      }
      if (args[0] === 'search') {
        return '[]';
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });

    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      debounceMs: 60_000,
      pollIntervalMs: 1000,
      runGhFn,
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
    const runGhFn = vi.fn(async (args: string[]) => {
      if (args[0] === 'api' && args[1]?.includes('/comments')) {
        return JSON.stringify([
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
        ]);
      }
      if (args[0] === 'search') {
        return '[]';
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });

    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      cursor: { lastIssueCommentId: '100', pullRequests: {} },
      debounceMs: 100,
      pollIntervalMs: 60_000,
      runGhFn,
      onUpdate,
    });

    monitor.start();
    await drainAsync();
    expect(runGhFn).toHaveBeenCalledTimes(2);

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
    const runGhFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pollResolve = () => resolve('[]');
        }),
    );

    const onUpdate = vi.fn();
    const monitor = createGitHubMonitor({
      issueUrl: 'https://github.com/org/repo/issues/39',
      debounceMs: 60_000,
      pollIntervalMs: 60_000,
      stopPollWaitMs: 50,
      runGhFn,
      onUpdate,
    });

    monitor.start();
    await drainAsync();
    expect(runGhFn).toHaveBeenCalledTimes(1);

    const stopPromise = monitor.stop();
    await stopPromise;

    expect(runGhFn).toHaveBeenCalledTimes(1);
    pollResolve?.();
    await drainAsync();
    vi.useFakeTimers();
  });
});
