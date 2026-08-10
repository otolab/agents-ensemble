import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDispatchResult } from '../../src/dispatch/worker-dispatch.js';
import { WorkerSession } from '../../src/runtime/worker-session.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';

describe('WorkerSession integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches worker, completes bootstrap via inbox, and stays resident until stop', async () => {
    vi.spyOn(worktreeModule, 'createWorkerWorktree').mockResolvedValue(TEST_WORKTREE);

    const bridge = await createInProcessAcpBridge();
    const completed: WorkerDispatchResult[] = [];

    const session = new WorkerSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: '/repo',
      workers: [
        {
          name: 'ping-1',
          kind: 'ping',
          systemPrompt: PING_SYSTEM_PROMPT,
        },
      ],
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      onWorkerCompleted: (result) => {
        completed.push(result);
      },
    });

    session.bootstrap();
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.name).toBe('ping-1');
    expect(completed[0]?.promptResult.responseText).toBe('pong');
    expect(session.runtime.attachedCount).toBe(1);
    expect(session.runtime.getAttached('ping-1')?.session.sessionId).toBeTruthy();

    await session.stop();
    expect(session.runtime.attachedCount).toBe(0);
  });

  it('accepts follow-up instructions via sendWorkerMessage', async () => {
    vi.spyOn(worktreeModule, 'createWorkerWorktree').mockResolvedValue(TEST_WORKTREE);

    const bridge = await createInProcessAcpBridge();
    const completed: WorkerDispatchResult[] = [];

    const session = new WorkerSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: '/repo',
      workers: [
        {
          name: 'ping-1',
          kind: 'ping',
          systemPrompt: PING_SYSTEM_PROMPT,
        },
      ],
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      onWorkerCompleted: (result) => {
        completed.push(result);
      },
    });

    session.bootstrap();
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    const sent = session.sendWorkerMessage('ping-1', 'second round task');
    expect(sent).toEqual({ status: 'sent', worker: 'ping-1' });

    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(completed).toHaveLength(2);
    expect(completed[1]?.prompt).toBe('second round task');
    expect(completed[1]?.promptResult.responseText).toBe('pong');

    await session.stop();
  });
});
