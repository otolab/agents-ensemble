import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOpenQuestionControlServer } from '@agents-ensemble/core';
import { createOperatorDispatchQueue } from './operator-dispatch.js';
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
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sendOperatorMessage = vi.fn(() => true);
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
      sendOperatorMessage,
    });
    closeServer = () => server.close();
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', 'conductor-1.json'),
      JSON.stringify({
        version: 1,
        conductorAgentId: 'conductor-1',
        issueUrl: 'https://github.com/example/repo/issues/1',
        repoRoot,
        harnessSocketPath: server.socketPath,
        profile: { workers: [], agents: {} },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: 1,
      }),
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
});
