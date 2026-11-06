import { describe, expect, it, vi } from 'vitest';
import { AcpSessionConfigOptionError } from '../acp/acp-client.js';
import { openWorkerAcpSession } from './worker-acp-session.js';

describe('openWorkerAcpSession resume spawn validation', () => {
  it('fails attach when saved resume store acpSpawn mismatches current profile', async () => {
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
          preset: 'cursor',
          command: 'agent',
          args: ['acp'],
        },
        currentAcpSpawn: {
          preset: 'claude',
          command: 'claude-agent-acp',
          args: [],
        },
      }),
    ).rejects.toThrow(/resume ACP spawn mismatch/);
  });

  it('fails attach when saved Pi ACP spawn data mismatches the current profile', async () => {
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
          command: 'pi-acp',
          args: [],
        },
        currentAcpSpawn: {
          preset: 'cursor',
          command: 'agent',
          args: ['acp'],
        },
      }),
    ).rejects.toThrow(/resume ACP spawn mismatch/);
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
});
