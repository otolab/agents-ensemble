import { describe, expect, it, vi } from 'vitest';
import type { AcpBridge } from '../acp/acp-bridge.js';
import { WorkerSession } from './worker-session.js';

const TEST_WORKTREE = {
  path: '/tmp/wt',
  branch: 'ensemble/issue-1',
  issue: {
    owner: 'org',
    repo: 'repo',
    number: 1,
    url: 'https://github.com/org/repo/issues/1',
  },
};

describe('WorkerSession', () => {
  it('attaches workers at bootstrap and closes on stop', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const connectAcp = vi.fn(async () =>
      ({
        newSession: vi.fn().mockResolvedValue('sess-1'),
        loadSession: vi.fn().mockResolvedValue(undefined),
        promptSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
        close,
      }) as unknown as AcpBridge,
    );

    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [{ name: 'ping-1', kind: 'ping', systemPrompt: 'pong only' }],
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      connectAcp,
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    });

    session.bootstrap();
    await session.stop();

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(connectAcp).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(session.runtime.attachedCount).toBe(0);
  });
});
