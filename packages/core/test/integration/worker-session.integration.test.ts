import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchWorker } from '../../src/dispatch/worker-dispatch.js';
import { WorkerSession } from '../../src/runtime/worker-session.js';
import type { WorkerDispatchResult } from '../../src/dispatch/worker-dispatch.js';
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

  it('bootstraps worker, completes via inbox, and surfaces pong to callback', async () => {
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
      dispatchWorker: (options) =>
        dispatchWorker({
          ...options,
          name: 'ping-1',
          bridge,
        }),
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      onWorkerCompleted: (result) => {
        completed.push(result);
      },
    });

    session.bootstrap();
    await session.stop();

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.name).toBe('ping-1');
    expect(completed[0]?.promptResult.responseText).toBe('pong');
  });
});
