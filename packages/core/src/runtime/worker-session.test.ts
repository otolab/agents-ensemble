import { describe, expect, it, vi } from 'vitest';
import { AcpBridge } from '../acp/acp-bridge.js';
import { AcpClient } from '../acp/acp-client.js';
import { createInProcessStreamPair } from '../acp/testing/stream-pair.js';
import { startFakeAcpServer } from '../acp/testing/fake-acp-server.js';
import type { PermissionDecision, PermissionHandler } from '../acp/types.js';
import { deny } from '../permission/permission-broker.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
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
  it('attaches workers at startWorkers and closes on stop', async () => {
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
      workers: [{ name: 'ping-1', kind: 'ping', prompt: { instructions: ['pong only'] } }],
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      connectAcp,
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    });

    session.startWorkers();
    await session.stop();

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(connectAcp).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(session.runtime.attachedCount).toBe(0);
  });

  it('denies pending permission when an ACP worker fails', async () => {
    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    const failures: Array<{ error: string }> = [];
    let permissionPromise: Promise<PermissionDecision> | undefined;
    const promptSession = vi.fn(
      async (
        _sessionId: string,
        _prompt: string,
        options?: { permissionHandler?: PermissionHandler },
      ) => {
        const decision = options?.permissionHandler?.({
          toolName: 'Shell',
          options: [{ optionId: 'backend-deny', kind: 'reject_once' }],
          raw: {},
        });
        if (!decision) {
          throw new Error('permission handler was not provided');
        }
        permissionPromise = Promise.resolve(decision);
        throw new Error('ACP quota exceeded');
      },
    );
    const close = vi.fn().mockResolvedValue(undefined);

    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [{ name: 'ping-1', kind: 'ping', prompt: { instructions: ['pong only'] } }],
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      permissionPipeline: pipeline,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          close,
        }) as unknown as AcpBridge,
      onWorkerFailed: (failure) => {
        failures.push({ error: failure.error });
      },
    });

    session.startWorkers();
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    await expect(permissionPromise).resolves.toEqual(
      deny({
        options: [{ optionId: 'backend-deny', kind: 'reject_once' }],
      }),
    );
    expect(pipeline.pending.size).toBe(0);
    expect(failures).toEqual([{ error: 'ACP quota exceeded' }]);

    await session.stop();
  });

  it('denies pending permission when the ACP response pipe is closed', async () => {
    const streams = createInProcessStreamPair();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
    });
    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });
    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    const failures: string[] = [];

    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [{ name: 'ping-1', kind: 'ping', prompt: { instructions: ['pong only'] } }],
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      permissionPipeline: pipeline,
      connectAcp: async () => {
        await client.connect();
        return AcpBridge.fromClient(client);
      },
      ownsWorkerAcpConnections: false,
      onWorkerFailed: (failure) => failures.push(failure.error),
    });

    session.startWorkers();
    await vi.waitFor(() => {
      expect(pipeline.pending.size).toBe(1);
    });

    streams.clientWritable.destroy(
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    );

    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(pipeline.pending.size).toBe(0);
    expect(failures).toContain('write EPIPE');

    await session.stop();
    await client.close();
  });

  it('bootstrap() delegates to startWorkers()', async () => {
    const connectAcp = vi.fn(async () =>
      ({
        newSession: vi.fn().mockResolvedValue('sess-1'),
        loadSession: vi.fn().mockResolvedValue(undefined),
        promptSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
        close: vi.fn().mockResolvedValue(undefined),
      }) as unknown as AcpBridge,
    );

    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [{ name: 'ping-1', kind: 'ping', prompt: { instructions: ['pong only'] } }],
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

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(connectAcp).toHaveBeenCalledOnce();
  });
});
