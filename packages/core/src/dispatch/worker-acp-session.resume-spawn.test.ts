import { describe, expect, it } from 'vitest';
import { openWorkerAcpSession } from './worker-acp-session.js';

describe('openWorkerAcpSession resume spawn validation', () => {
  it('fails attach when sidecar acpSpawn mismatches current profile', async () => {
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

  it('fails attach when sidecar pi acpSpawn mismatches current profile', async () => {
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
});
