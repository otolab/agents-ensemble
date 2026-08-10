import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchWorker } from '../../src/dispatch/worker-dispatch.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';

describe('dispatchWorker integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs in-process Fake ACP and returns pong in responseText', async () => {
    vi.spyOn(worktreeModule, 'createWorkerWorktree').mockResolvedValue(TEST_WORKTREE);

    const bridge = await createInProcessAcpBridge();
    const result = await dispatchWorker({
      issueUrl: TEST_ISSUE.url,
      name: 'ping-1',
      kind: 'ping',
      systemPrompt: PING_SYSTEM_PROMPT,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      repoRoot: '/repo',
      bridge,
    });

    expect(result.name).toBe('ping-1');
    expect(result.kind).toBe('ping');
    expect(result.prompt).toContain(PING_SYSTEM_PROMPT);
    expect(result.prompt).toContain('agent kind: ping');
    expect(result.promptResult.stopReason).toBe('end_turn');
    expect(result.promptResult.responseText).toBe('pong');
  });
});
