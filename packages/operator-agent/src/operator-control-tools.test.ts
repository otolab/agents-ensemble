import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOpenQuestionControlServer } from '@agents-ensemble/core';
import { resolveEnsemblePaths } from '@agents-ensemble/core/operator-runtime';
import {
  saveSessionResumeStore,
  SESSION_RESUME_STORE_VERSION,
} from '../../core/src/session/session-resume-store.js';
import {
  createOperatorDispatchQueue,
  DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
} from './operator-dispatch.js';
import { createSetSessionFocusTool } from './operator-control-tools.js';
import { createSendOperatorMessageTool } from './open-question-control-tools.js';

describe('operator control tools', () => {
  let repoRoot = '';
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
  });

  it('sends the #525 operator message through live UDS while reports are held', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-control-'));
    const sendOperatorMessage = vi.fn(() => true);
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
      sendOperatorMessage,
    });
    closeServer = () => server.close();
    const issueUrl = 'https://github.com/example/repo/issues/1';
    await saveSessionResumeStore(
      resolveEnsemblePaths({ repoRoot }).canonicalSessionResumeStorePath(
        issueUrl,
        'conductor-1',
      ),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: 'conductor-1',
        issueUrl,
        repoRoot,
        harnessSocketPath: server.socketPath,
        profile: { workers: [], agents: {} },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: 1,
      },
    );
    const queue = createOperatorDispatchQueue();
    queue.setHold(true);
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        conductorAgentId: 'conductor-1',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'held report',
      },
      0,
    );

    const tool = createSendOperatorMessageTool(repoRoot);
    const result = await tool.execute({
      conductorAgentId: 'conductor-1',
      text: 'CI を確認してください',
    });

    expect(result.structuredContent).toEqual({
      queued: true,
      delivery: 'next',
    });
    expect(sendOperatorMessage).toHaveBeenCalledWith({
      text: 'CI を確認してください',
      delivery: 'next',
    });
    expect(queue.heldEventCount).toBe(1);
    expect(queue.pendingEventCount).toBe(0);
  });

  it('sets and clears explicit session focus through the operator tool', async () => {
    const queue = createOperatorDispatchQueue();
    const tool = createSetSessionFocusTool(queue);

    await tool.execute({ conductorAgentId: 'session-17' });
    expect(queue.focusSessionId).toBe('session-17');
    expect(tool.description).toContain('including Open Questions, is paused');
    expect(tool.description).toContain('failsafe');
    expect(tool.description).toContain(
      'common.scheduling.focusInactivityTimeoutMs',
    );
    expect(tool.description).toContain('3–30 minutes');
    expect(tool.description).toContain(
      'Only operator/user input received by operator-agent resets the timeout',
    );

    await tool.execute({});
    expect(queue.focusSessionId).toBeUndefined();
  });

  it('does not reset the human-input focus deadline from a tool call or worker report', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue({
      ...DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
      focusInactivityTimeoutMs: 10_000,
    });
    const tool = createSetSessionFocusTool(queue);
    try {
      queue.noteOperatorInput();
      queue.setFocus('focused-session');
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'focused-session',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'focused update',
        },
        0,
      );
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'open_question',
          conductorAgentId: 'outside-session',
          issueUrl: 'https://github.com/example/repo/issues/2',
          text: 'outside question',
        },
        0,
      );

      now.mockReturnValue(5_000);
      queue.noteOperatorInput();
      now.mockReturnValue(9_000);
      await tool.execute({ conductorAgentId: 'focused-session' });
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'worker-update',
          issueUrl: 'https://github.com/example/repo/issues/3',
          text: 'automatic worker report',
        },
        0,
      );

      expect(
        queue.selectBatch({ continuationConsumed: false }, 14_999)?.sourceKey,
      ).toBe('session:focused-session');
      expect(queue.focusSessionId).toBe('focused-session');
      expect(
        queue.selectBatch({ continuationConsumed: false }, 15_000)?.sourceKey,
      ).toBe('session:outside-session');
      expect(queue.focusSessionId).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('does not renew the focus failsafe by toggling focus through tool calls', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue({
      ...DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
      focusInactivityTimeoutMs: 10_000,
    });
    const tool = createSetSessionFocusTool(queue);
    try {
      await tool.execute({ conductorAgentId: 'focused-session' });
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'focused-session',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'focused update',
        },
        0,
      );
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'open_question',
          conductorAgentId: 'outside-session',
          issueUrl: 'https://github.com/example/repo/issues/2',
          text: 'outside question',
        },
        0,
      );

      now.mockReturnValue(5_000);
      await tool.execute({});
      now.mockReturnValue(8_000);
      await tool.execute({ conductorAgentId: 'focused-session' });

      expect(
        queue.selectBatch({ continuationConsumed: false }, 10_999)?.sourceKey,
      ).toBe('session:focused-session');
      expect(
        queue.selectBatch({ continuationConsumed: false }, 11_000)?.sourceKey,
      ).toBe('session:outside-session');
      expect(queue.focusSessionId).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });
});
