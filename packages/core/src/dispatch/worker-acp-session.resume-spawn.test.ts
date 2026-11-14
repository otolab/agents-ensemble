import { describe, expect, it, vi } from 'vitest';
import { AcpSessionConfigOptionError } from '../acp/acp-client.js';
import { openWorkerAcpSession } from './worker-acp-session.js';

describe('openWorkerAcpSession resume spawn validation', () => {
  it('attempts session/load with the current preset when saved spawn differs', async () => {
    const loadSession = vi.fn().mockResolvedValue(undefined);
    const newSession = vi.fn();
    const opened = await openWorkerAcpSession({
      issueUrl: 'https://github.com/org/repo/issues/1',
      worktree: {
        path: '/tmp/worktree',
        branch: 'ensemble/issue-1',
        issue: {
          owner: 'org',
          repo: 'repo',
          number: 1,
          url: 'https://github.com/org/repo/issues/1',
        },
        inRepo: false,
      },
      workerName: 'implementer',
      resumeAcpSessionId: 'session-1',
      expectedResumeAcpSpawn: {
        preset: 'cursor',
        command: 'agent',
        args: ['acp'],
      },
      currentAcpSpawn: {
        preset: 'claude',
        command: 'claude-agent-acp',
        args: [],
      },
      bridge: {
        loadSession,
        newSession,
        close: vi.fn(),
      } as never,
    });

    expect(opened.sessionId).toBe('session-1');
    expect(opened.resumed).toBe(true);
    expect(loadSession).toHaveBeenCalledWith(
      'session-1',
      '/tmp/worktree',
      undefined,
    );
    expect(newSession).not.toHaveBeenCalled();
  });

  it('does not treat builtin Pi restore failure as a new session success', async () => {
    const loadSession = vi
      .fn()
      .mockRejectedValue(new Error('saved Pi session is unavailable'));
    const newSession = vi.fn().mockResolvedValue('unexpected-new-session');
    await expect(
      openWorkerAcpSession({
        issueUrl: 'https://github.com/org/repo/issues/1',
        worktree: {
          path: '/tmp/worktree',
          branch: 'ensemble/issue-1',
          issue: {
            owner: 'org',
            repo: 'repo',
            number: 1,
            url: 'https://github.com/org/repo/issues/1',
          },
          inRepo: false,
        },
        workerName: 'implementer',
        resumeAcpSessionId: 'session-1',
        expectedResumeAcpSpawn: {
          preset: 'pi',
          piRuntime: 'builtin',
          command: 'pi-acp',
          args: [],
        },
        currentAcpSpawn: {
          preset: 'cursor',
          command: 'agent',
          args: ['acp'],
        },
        bridge: {
          loadSession,
          newSession,
          close: vi.fn(),
        } as never,
      }),
    ).rejects.toThrow(/could not resume builtin Pi ACP session/);
    expect(loadSession).toHaveBeenCalledOnce();
    expect(newSession).not.toHaveBeenCalled();
  });

  it('loads the saved session when its model reasoning metadata differs', async () => {
    const loadSession = vi.fn().mockResolvedValue(undefined);
    const newSession = vi.fn().mockResolvedValue('unexpected-new-session');
    const opened = await openWorkerAcpSession({
      issueUrl: 'https://github.com/org/repo/issues/1',
      worktree: {
        path: '/tmp/worktree',
        branch: 'ensemble/issue-1',
        issue: {
          owner: 'org',
          repo: 'repo',
          number: 1,
          url: 'https://github.com/org/repo/issues/1',
        },
        inRepo: false,
      },
      workerName: 'implementer',
      resumeAcpSessionId: 'session-1',
      expectedResumeAcpSpawn: {
        preset: 'claude',
        command: 'claude-agent-acp',
        args: [],
        modelTag: 'high',
        model: 'provider/opus',
        reasoning: 'low',
      },
      currentAcpSpawn: {
        preset: 'claude',
        command: 'claude-agent-acp',
        args: [],
        modelTag: 'high',
        model: 'provider/opus',
        reasoning: 'high',
      },
      bridge: {
        loadSession,
        newSession,
        close: vi.fn(),
      } as never,
    });

    expect(opened.sessionId).toBe('session-1');
    expect(loadSession).toHaveBeenCalledOnce();
    expect(loadSession).toHaveBeenCalledWith(
      'session-1',
      '/tmp/worktree',
      undefined,
    );
    expect(newSession).not.toHaveBeenCalled();
  });

  it('accepts an older saved fingerprint without a reasoning field', async () => {
    const loadSession = vi.fn();
    const newSession = vi.fn();
    const bridge = {
      loadSession,
      newSession,
      close: vi.fn(),
    };
    const session = await openWorkerAcpSession({
      issueUrl: 'https://github.com/org/repo/issues/1',
      worktree: {
        path: '/tmp/worktree',
        branch: 'ensemble/issue-1',
        issue: {
          owner: 'org',
          repo: 'repo',
          number: 1,
          url: 'https://github.com/org/repo/issues/1',
        },
        inRepo: false,
      },
      workerName: 'implementer',
      resumeAcpSessionId: 'session-1',
      expectedResumeAcpSpawn: {
        preset: 'codex',
        command: 'codex-acp',
        args: [],
        modelTag: 'high',
        model: 'provider/opus',
      },
      currentAcpSpawn: {
        preset: 'codex',
        command: 'codex-acp',
        args: [],
        modelTag: 'high',
        model: 'provider/opus',
        reasoning: 'high',
      },
      bridge: bridge as never,
    });

    expect(loadSession).toHaveBeenCalledOnce();
    expect(newSession).not.toHaveBeenCalled();
    expect(session.sessionId).toBe('session-1');
  });

  it('does not start a fresh session when resume option verification fails', async () => {
    const newSession = vi.fn();
    const bridge = {
      loadSession: vi
        .fn()
        .mockRejectedValue(
          new AcpSessionConfigOptionError('requested reasoning option was not applied'),
        ),
      newSession,
      close: vi.fn(),
    };

    await expect(
      openWorkerAcpSession({
        issueUrl: 'https://github.com/org/repo/issues/1',
        worktree: {
          path: '/tmp/worktree',
          branch: 'ensemble/issue-1',
          issue: {
            owner: 'org',
            repo: 'repo',
            number: 1,
            url: 'https://github.com/org/repo/issues/1',
          },
          inRepo: false,
        },
        resumeAcpSessionId: 'session-1',
        bridge: bridge as never,
      }),
    ).rejects.toThrow(/requested reasoning option was not applied/);

    expect(newSession).not.toHaveBeenCalled();
  });

  it('fails closed when a builtin Pi session cannot be resumed', async () => {
    const loadSession = vi
      .fn()
      .mockRejectedValue(new Error('Unknown sessionId: saved-pi-session'));
    const newSession = vi.fn().mockResolvedValue('fresh-session');
    const bridge = {
      loadSession,
      newSession,
      close: vi.fn(),
    };
    const connectAcp = vi.fn(async () => bridge as never);

    await expect(
      openWorkerAcpSession({
        issueUrl: 'https://github.com/org/repo/issues/1',
        worktree: {
          path: '/tmp/worktree',
          branch: 'ensemble/issue-1',
          issue: {
            owner: 'org',
            repo: 'repo',
            number: 1,
            url: 'https://github.com/org/repo/issues/1',
          },
          inRepo: false,
        },
        workerName: 'implementer',
        resumeAcpSessionId: 'saved-pi-session',
        currentAcpSpawn: {
          preset: 'pi',
          command: 'node',
          args: ['pi-acp-wrapper.js'],
          piRuntime: 'builtin',
        },
        connectAcp,
      }),
    ).rejects.toThrow(
      /could not resume builtin Pi ACP session "saved-pi-session".*Refusing to start a new session without the saved context.*Unknown sessionId/u,
    );

    expect(connectAcp).toHaveBeenCalledOnce();
    expect(loadSession).toHaveBeenCalledOnce();
    expect(newSession).not.toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it('keeps BYO Pi resume-load fallback behavior unchanged', async () => {
    const loadSession = vi
      .fn()
      .mockRejectedValue(new Error('Unknown sessionId: byo-session'));
    const newSession = vi.fn().mockResolvedValue('fresh-byo-session');
    const bridge = {
      loadSession,
      newSession,
      close: vi.fn(),
    };

    const opened = await openWorkerAcpSession({
      issueUrl: 'https://github.com/org/repo/issues/1',
      worktree: {
        path: '/tmp/worktree',
        branch: 'ensemble/issue-1',
        issue: {
          owner: 'org',
          repo: 'repo',
          number: 1,
          url: 'https://github.com/org/repo/issues/1',
        },
        inRepo: false,
      },
      workerName: 'implementer',
      resumeAcpSessionId: 'byo-session',
      currentAcpSpawn: {
        preset: 'pi',
        command: 'pi-acp',
        args: [],
      },
      bridge: bridge as never,
    });

    expect(loadSession).toHaveBeenCalledOnce();
    expect(newSession).toHaveBeenCalledOnce();
    expect(opened.sessionId).toBe('fresh-byo-session');
  });
});
