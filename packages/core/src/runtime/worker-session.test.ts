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
    await session.runtime.waitForIdle();

    expect(connectAcp).toHaveBeenCalledOnce();
    expect(session.runtime.getWorkerStatus('ping-1')?.state).toBe('idle');
    await session.stop();

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(connectAcp).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(session.runtime.attachedCount).toBe(0);
  });

  it('keeps lazy workers asleep until their first instruction, then stays resident', async () => {
    const prompts: string[] = [];
    const completedSources: Array<string | undefined> = [];
    const promptSession = vi.fn(async (_sessionId: string, prompt: string) => {
      prompts.push(prompt);
      return { stopReason: 'end_turn', responseText: 'pong' };
    });
    const connectAcp = vi.fn(async () =>
      ({
        newSession: vi.fn().mockResolvedValue('sess-1'),
        loadSession: vi.fn().mockResolvedValue(undefined),
        promptSession,
        close: vi.fn().mockResolvedValue(undefined),
      }) as unknown as AcpBridge,
    );
    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [
        { name: 'ping-1', kind: 'ping', prompt: { instructions: ['pong only'] } },
        { name: 'ping-2', kind: 'ping', prompt: { instructions: ['pong only'] } },
      ],
      lazyWorkers: true,
      sessionState: {
        workers: [
          { name: 'ping-1', kind: 'ping' },
          { name: 'ping-2', kind: 'ping' },
        ],
        kinds: ['ping'],
      },
      connectAcp,
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    });
    session.inbox.subscribe((message) => {
      if (message.type === 'worker.completed') {
        completedSources.push(message.result.source);
      }
    });

    session.startWorkers();

    expect(connectAcp).not.toHaveBeenCalled();
    expect(session.runtime.attachedCount).toBe(0);
    expect(session.runtime.listWorkerStatuses().map(({ state }) => state)).toEqual([
      'sleeping',
      'sleeping',
    ]);

    expect(session.sendWorkerMessage('ping-1', 'first instruction')).toEqual({
      status: 'sent',
      worker: 'ping-1',
    });
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(connectAcp).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('init prompt');
    expect(prompts[1]).toBe('first instruction');
    expect(completedSources).toEqual(['harness', 'conductor']);
    expect(session.runtime.getWorkerStatus('ping-2')?.state).toBe('sleeping');

    expect(session.sendWorkerMessage('ping-1', 'second instruction')).toEqual({
      status: 'sent',
      worker: 'ping-1',
    });
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(connectAcp).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toBe('second instruction');
    expect(completedSources).toEqual(['harness', 'conductor', 'conductor']);
    expect(session.runtime.getWorkerStatus('ping-1')?.state).toBe('idle');

    await session.stop();
  });

  it('queues prompts while lazy attach is in flight and applies preempt after init', async () => {
    let resolveBridge: ((bridge: AcpBridge) => void) | undefined;
    const prompts: string[] = [];
    const connectAcp = vi.fn(
      () =>
        new Promise<AcpBridge>((resolve) => {
          resolveBridge = resolve;
        }),
    );
    const promptSession = vi.fn(async (_sessionId: string, prompt: string) => {
      prompts.push(prompt);
      return { stopReason: 'end_turn', responseText: 'pong' };
    });
    const bridge = {
      newSession: vi.fn().mockResolvedValue('sess-1'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [{ name: 'ping-1', kind: 'ping' }],
      lazyWorkers: true,
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
    expect(session.sendWorkerMessage('ping-1', 'first instruction').status).toBe(
      'sent',
    );
    expect(session.sendWorkerMessage('ping-1', 'queued instruction')).toEqual({
      status: 'queued',
      worker: 'ping-1',
      position: 2,
    });
    expect(
      session.sendWorkerMessage('ping-1', 'preempt instruction', {
        preempt: true,
      }),
    ).toEqual({
      status: 'queued',
      worker: 'ping-1',
      position: 1,
    });
    expect(session.runtime.getWorkerStatus('ping-1')).toMatchObject({
      state: 'attaching',
      queuePreview: [],
      preemptPending: true,
    });

    resolveBridge?.(bridge);
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('init prompt');
    expect(prompts[1]).toBe('preempt instruction');
    await session.stop();
  });

  it('keeps the first instruction queued while lazy init waits for permission', async () => {
    const prompts: string[] = [];
    let permissionId: string | undefined;
    const promptSession = vi.fn(
      async (
        _sessionId: string,
        prompt: string,
        options?: { permissionHandler?: PermissionHandler },
      ) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          const decision = options?.permissionHandler?.({
            toolName: 'Shell',
            options: [{ optionId: 'allow-once', kind: 'allow_once' }],
            raw: { command: 'echo test' },
          });
          if (!decision) {
            throw new Error('permission handler was not provided');
          }
          await decision;
        }
        return { stopReason: 'end_turn', responseText: 'pong' };
      },
    );
    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [{ name: 'ping-1', kind: 'ping' }],
      lazyWorkers: true,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as AcpBridge,
      decidePermission: () => null,
    });
    session.inbox.subscribe((message) => {
      if (message.type === 'permission.request') {
        permissionId = message.id;
      }
    });

    session.startWorkers();
    session.sendWorkerMessage('ping-1', 'first instruction');

    await vi.waitFor(() => {
      expect(permissionId).toBeDefined();
    });
    expect(prompts).toHaveLength(1);
    expect(session.runtime.getWorkerStatus('ping-1')).toMatchObject({
      state: 'processing',
      queuePreview: ['first instruction'],
    });

    session.inbox.fulfillPermission(permissionId!, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('init prompt');
    expect(prompts[1]).toBe('first instruction');
    await session.stop();
  });

  it('reports lazy attach failure and rejects later prompts for that worker', async () => {
    const failures: string[] = [];
    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [{ name: 'ping-1', kind: 'ping' }],
      lazyWorkers: true,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      connectAcp: async () => {
        throw new Error('ACP unavailable');
      },
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      onWorkerFailed: (failure) => failures.push(failure.error),
    });

    session.startWorkers();
    expect(session.sendWorkerMessage('ping-1', 'first instruction').status).toBe(
      'sent',
    );
    await session.runtime.waitForIdle();
    await session.inbox.drain();

    expect(session.runtime.getWorkerStatus('ping-1')).toMatchObject({
      state: 'failed',
      error: 'ACP unavailable',
    });
    expect(failures).toEqual(['ACP unavailable']);
    expect(session.sendWorkerMessage('ping-1', 'retry')).toMatchObject({
      status: 'error',
      message: 'Worker "ping-1" failed to attach: ACP unavailable',
    });
    expect(session.sendWorkerMessage('unknown', 'task')).toMatchObject({
      status: 'error',
      message: 'Worker "unknown" is not registered',
    });

    await session.stop();
  });

  it('restores only workers with saved ACP sessions when lazy attach is enabled', async () => {
    const connectAcp = vi.fn(async () =>
      ({
        newSession: vi.fn().mockResolvedValue('sess-new'),
        loadSession: vi.fn().mockResolvedValue(undefined),
        promptSession: vi.fn().mockResolvedValue({
          stopReason: 'end_turn',
          responseText: 'ready',
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }) as unknown as AcpBridge,
    );
    const session = new WorkerSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      workers: [
        { name: 'ping-1', kind: 'ping' },
        { name: 'ping-2', kind: 'ping' },
      ],
      lazyWorkers: true,
      restoredWorkerSessions: {
        'ping-1': { acpSessionId: 'saved-session' },
      },
      sessionState: {
        workers: [
          { name: 'ping-1', kind: 'ping' },
          { name: 'ping-2', kind: 'ping' },
        ],
        kinds: ['ping'],
      },
      connectAcp,
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    });

    session.startWorkers();

    expect(connectAcp).toHaveBeenCalledOnce();
    expect(session.runtime.getWorkerStatus('ping-2')?.state).toBe('sleeping');
    await session.runtime.waitForIdle();
    await session.inbox.drain();
    expect(session.runtime.getWorkerStatus('ping-1')?.state).toBe('idle');

    await session.stop();
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
