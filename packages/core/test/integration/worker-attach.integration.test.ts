import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachWorker,
  buildWorkerAttachPrompt,
  runAttachedWorkerPrompt,
} from '../../src/dispatch/attach-worker.js';
import { closeWorkerAcpSession } from '../../src/dispatch/worker-acp-session.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';

describe('attachWorker integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs in-process Fake ACP and returns pong in responseText', async () => {
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(TEST_WORKTREE);

    const bridge = await createInProcessAcpBridge();
    const sessionState = {
      workers: [{ name: 'ping-1', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'ping-1',
      kind: 'ping',
      systemPrompt: PING_SYSTEM_PROMPT,
      sessionState,
      worktree: TEST_WORKTREE,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const prompt = buildWorkerAttachPrompt(attachOptions, attached.session);
    const result = await runAttachedWorkerPrompt(attached, prompt);
    await closeWorkerAcpSession(attached.session);

    expect(result.name).toBe('ping-1');
    expect(result.kind).toBe('ping');
    expect(result.prompt).toContain(PING_SYSTEM_PROMPT);
    expect(result.prompt).toContain('**ping**');
    expect(result.promptResult.stopReason).toBe('end_turn');
    expect(result.promptResult.responseText).toBe('pong');
  });
});
