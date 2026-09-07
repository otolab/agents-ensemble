import { describe, expect, it, vi } from 'vitest';
import { emptyGitHubMonitorCursor } from './github-monitor-cursor.js';
import { createRegisterGitHubWatchTool } from './register-github-watch-tool.js';

const ISSUE_URL = 'https://github.com/org/repo/issues/39';

describe('createRegisterGitHubWatchTool', () => {
  it('registers a PR by number with the default watch kinds', async () => {
    const cursor = emptyGitHubMonitorCursor();
    const onRegistered = vi.fn();
    const tools = createRegisterGitHubWatchTool({
      issueUrl: ISSUE_URL,
      getCursor: () => cursor,
      onRegistered,
      now: () => new Date('2026-09-07T05:00:00.000Z'),
    });

    const result = await tools.register_github_watch.execute({
      prNumber: 354,
    });

    expect(result.structuredContent).toEqual({
      ok: true,
      prNumber: 354,
      url: 'https://github.com/org/repo/pull/354',
      kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
      message: 'Registered for harness GitHub monitor',
    });
    expect(cursor.explicitPullRequests).toEqual({
      '354': {
        registeredAt: '2026-09-07T05:00:00.000Z',
        kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
      },
    });
    expect(onRegistered).toHaveBeenCalledWith({
      prNumber: 354,
      registeredAt: '2026-09-07T05:00:00.000Z',
      kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
    });
  });

  it('accepts a same-repository PR URL and preserves custom kinds', async () => {
    const cursor = emptyGitHubMonitorCursor();
    const tools = createRegisterGitHubWatchTool({
      issueUrl: ISSUE_URL,
      getCursor: () => cursor,
      now: () => new Date('2026-09-07T05:01:00.000Z'),
    });

    const result = await tools.register_github_watch.execute({
      prUrl: 'https://github.com/org/repo/pull/355/',
      kinds: ['pr.review'],
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      prNumber: 355,
      url: 'https://github.com/org/repo/pull/355',
      kinds: ['pr.review'],
    });
    expect(cursor.explicitPullRequests?.['355']?.kinds).toEqual(['pr.review']);
  });

  it('makes duplicate registration a no-op', async () => {
    const cursor = emptyGitHubMonitorCursor();
    const onRegistered = vi.fn();
    const tools = createRegisterGitHubWatchTool({
      issueUrl: ISSUE_URL,
      getCursor: () => cursor,
      onRegistered,
      now: () => new Date('2026-09-07T05:02:00.000Z'),
    });

    await tools.register_github_watch.execute({
      prNumber: 356,
      kinds: ['pr.review'],
    });
    const result = await tools.register_github_watch.execute({
      prUrl: 'https://github.com/org/repo/pull/356',
      kinds: ['ci.completed'],
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      prNumber: 356,
      kinds: ['pr.review'],
      message: 'Pull request is already registered for the harness GitHub monitor',
    });
    expect(onRegistered).toHaveBeenCalledOnce();
    expect(cursor.explicitPullRequests?.['356']?.kinds).toEqual(['pr.review']);
  });

  it('rejects a PR from a different repository', async () => {
    const cursor = emptyGitHubMonitorCursor();
    const tools = createRegisterGitHubWatchTool({
      issueUrl: ISSUE_URL,
      getCursor: () => cursor,
    });

    await expect(
      tools.register_github_watch.execute({
        prUrl: 'https://github.com/other/repo/pull/354',
      }),
    ).rejects.toThrow('same repository as the session Issue');
    expect(cursor.explicitPullRequests).toEqual({});
  });
});
