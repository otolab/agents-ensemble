import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpBridge } from '../../src/acp/acp-bridge.js';
import { AcpClient } from '../../src/acp/acp-client.js';
import type { WorkerDispatchResult } from '../../src/dispatch/worker-dispatch.js';
import { deny } from '../../src/permission/permission-broker.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import { WorkerSession } from '../../src/runtime/worker-session.js';
import { startFakeAcpServer } from '../../src/acp/testing/fake-acp-server.js';
import { createInProcessStreamPair } from '../../src/acp/testing/stream-pair.js';
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
    const bridge = await createInProcessAcpBridge();
    const completed: WorkerDispatchResult[] = [];

    const session = new WorkerSession({
      issueUrl: TEST_ISSUE.url,
      worktree: TEST_WORKTREE,
      workers: [
        {
          name: 'ping-1',
          kind: 'ping',
          prompt: { instructions: [PING_SYSTEM_PROMPT] },
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

    session.startWorkers();
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.name).toBe('ping-1');
    expect(completed[0]?.source).toBe('harness');
    expect(completed[0]?.promptResult.responseText).toBe('pong');
    expect(session.runtime.attachedCount).toBe(1);
    expect(session.runtime.getAttached('ping-1')?.session.sessionId).toBeTruthy();

    await session.stop();
    expect(session.runtime.attachedCount).toBe(0);
  });

  it('denies pending permission and forwards worker failure after ACP disconnects', async () => {
    const streams = createInProcessStreamPair();
    let permissionResponse: unknown;
    const fakeServer = startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
      permissionOptions: [{ optionId: 'backend-deny', kind: 'reject_once' }],
      onPermissionResponse: (response) => {
        permissionResponse = response;
      },
    });
    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });
    await client.connect();

    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    const failures: Array<{ error: string }> = [];
    const session = new WorkerSession({
      issueUrl: TEST_ISSUE.url,
      worktree: TEST_WORKTREE,
      workers: [
        {
          name: 'ping-1',
          kind: 'ping',
          prompt: { instructions: [PING_SYSTEM_PROMPT] },
        },
      ],
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      permissionPipeline: pipeline,
      connectAcp: async () => AcpBridge.fromClient(client),
      ownsWorkerAcpConnections: true,
      onWorkerFailed: (failure) => {
        failures.push({ error: failure.error });
      },
    });

    session.startWorkers();
    await vi.waitFor(() => {
      expect(pipeline.pending.size).toBe(1);
    });

    streams.clientReadable.destroy(new Error('ACP quota exceeded'));

    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(pipeline.pending.size).toBe(0);
    expect(failures).toEqual([{ error: 'ACP quota exceeded' }]);
    await vi.waitFor(() => {
      expect(permissionResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'backend-deny' },
      });
    });

    await session.stop();
    fakeServer.stop();
  });

  it('accepts follow-up instructions via sendWorkerMessage', async () => {
    const bridge = await createInProcessAcpBridge();
    const completed: WorkerDispatchResult[] = [];

    const session = new WorkerSession({
      issueUrl: TEST_ISSUE.url,
      worktree: TEST_WORKTREE,
      workers: [
        {
          name: 'ping-1',
          kind: 'ping',
          prompt: { instructions: [PING_SYSTEM_PROMPT] },
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

    session.startWorkers();
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    const sent = session.sendWorkerMessage('ping-1', 'second round task');
    expect(sent).toEqual({ status: 'sent', worker: 'ping-1' });

    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(completed).toHaveLength(2);
    expect(completed[0]?.source).toBe('harness');
    expect(completed[1]?.prompt).toBe('second round task');
    expect(completed[1]?.source).toBe('conductor');
    expect(completed[1]?.promptResult.responseText).toBe('pong');

    await session.stop();
  });
});
