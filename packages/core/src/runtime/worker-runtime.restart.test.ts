import { describe, expect, it, vi } from 'vitest';
import { AcpBridge } from '../acp/acp-bridge.js';
import { AcpClient } from '../acp/acp-client.js';
import { createInProcessStreamPair } from '../acp/testing/stream-pair.js';
import {
  startFakeAcpServer,
  type FakeAcpServer,
} from '../acp/testing/fake-acp-server.js';
import type { AcpBridge as AcpBridgeType } from '../acp/acp-bridge.js';
import { ConductorInbox } from './conductor-inbox.js';
import { WorkerRuntime } from './worker-runtime.js';

const WORKTREE = {
  path: '/tmp/wt',
  branch: 'ensemble/issue-910',
  issue: {
    owner: 'otolab',
    repo: 'agents-ensemble',
    number: 910,
    url: 'https://github.com/otolab/agents-ensemble/issues/910',
  },
};

interface FakeConnection {
  bridge: AcpBridgeType;
  server: FakeAcpServer;
  close: ReturnType<typeof vi.spyOn>;
  newSessions: string[];
  loadedSessions: string[];
  prompts: Array<{ sessionId: string; prompt: unknown }>;
}

async function connectFakeAcp(initialSessions: string[] = []): Promise<FakeConnection> {
  const pair = createInProcessStreamPair();
  const newSessions: string[] = [];
  const loadedSessions: string[] = [];
  const prompts: Array<{ sessionId: string; prompt: unknown }> = [];
  const server = startFakeAcpServer({
    readable: pair.serverReadable,
    writable: pair.serverWritable,
    initialSessions,
    onNewSession: () => {},
    onLoadSession: (params) => {
      loadedSessions.push((params as { sessionId: string }).sessionId);
    },
    onPrompt: ({ sessionId, prompt }) => {
      prompts.push({ sessionId, prompt });
      return { stopReason: 'end_turn', message: 'fake response' };
    },
  });
  const client = AcpClient.create({
    readable: pair.clientReadable,
    writable: pair.clientWritable,
  });
  await client.connect();
  const bridge = AcpBridge.fromClient(client);
  const close = vi.spyOn(bridge, 'close');
  const newSession = vi.spyOn(bridge, 'newSession').mockImplementation(async (cwd) => {
    const id = await client.newSession(cwd);
    newSessions.push(id);
    return id;
  });
  return { bridge, server, close, newSessions, loadedSessions, prompts };
}

function createRuntime(
  connectAcp: () => Promise<AcpBridgeType>,
  options: ConstructorParameters<typeof WorkerRuntime>[0] = {},
): WorkerRuntime {
  const runtime = new WorkerRuntime({
    inbox: new ConductorInbox(),
    connectAcp,
    ...options,
  });
  runtime.start({
    name: 'implementer',
    kind: 'implementer',
    issueUrl: WORKTREE.issue.url,
    worktree: WORKTREE,
    sessionState: {
      workers: [{ name: 'implementer', kind: 'implementer' }],
      kinds: ['implementer'],
    },
  });
  return runtime;
}

describe('WorkerRuntime.restartWorker', () => {
  it('closes the old ACP process and loads the same session into a new process', async () => {
    const connections: FakeConnection[] = [];
    const plans = [[], ['fake-session-1']];
    const runtime = createRuntime(async () => {
      const connection = await connectFakeAcp(plans.shift() ?? []);
      connections.push(connection);
      return connection.bridge;
    });
    try {
      await runtime.waitForIdle();
      expect(connections[0]?.newSessions).toEqual(['fake-session-1']);

      await expect(runtime.restartWorker('implementer')).resolves.toBe('fake-session-1');
      expect(connections[0]?.close).toHaveBeenCalledOnce();
      expect(connections[1]?.loadedSessions).toEqual(['fake-session-1']);
      expect(connections[1]?.newSessions).toEqual([]);
      expect(runtime.getWorkerStatus('implementer')).toMatchObject({
        state: 'idle',
        acpSessionId: 'fake-session-1',
      });

      expect(runtime.sendWorkerMessage('implementer', 'continue')).toMatchObject({ status: 'sent' });
      await runtime.waitForIdle();
      expect(connections[1]?.prompts.at(-1)).toMatchObject({
        sessionId: 'fake-session-1',
      });
    } finally {
      await runtime.shutdown();
      for (const connection of connections) connection.server.stop();
    }
  });

  it('keeps the old ID after strict load failure and retries that ID without creating a session', async () => {
    const connections: FakeConnection[] = [];
    const plans = [[], [], ['fake-session-1']];
    const runtime = createRuntime(async () => {
      const connection = await connectFakeAcp(plans.shift() ?? []);
      connections.push(connection);
      return connection.bridge;
    });
    try {
      await runtime.waitForIdle();
      await expect(runtime.restartWorker('implementer')).rejects.toThrow(
        /saved session "fake-session-1".*retry restart_worker/u,
      );
      expect(runtime.getWorkerStatus('implementer')?.state).toBe('failed');
      expect(connections[1]?.loadedSessions).toEqual(['fake-session-1']);
      expect(connections[1]?.newSessions).toEqual([]);

      await expect(runtime.restartWorker('implementer')).resolves.toBe('fake-session-1');
      expect(connections[2]?.loadedSessions).toEqual(['fake-session-1']);
      expect(connections[2]?.newSessions).toEqual([]);
      expect(runtime.getWorkerStatus('implementer')).toMatchObject({
        state: 'idle',
        acpSessionId: 'fake-session-1',
      });
    } finally {
      await runtime.shutdown();
      for (const connection of connections) connection.server.stop();
    }
  });

  it('does not spawn a replacement until the old process close is confirmed', async () => {
    const oldBridge = {
      newSession: vi.fn().mockResolvedValue('old-session'),
      loadSession: vi.fn(),
      promptSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      close: vi.fn()
        .mockRejectedValueOnce(new Error('child exit was not confirmed'))
        .mockResolvedValue(undefined),
    } as unknown as AcpBridgeType;
    const replacementBridge = {
      newSession: vi.fn(),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridgeType;
    const connectAcp = vi.fn()
      .mockResolvedValueOnce(oldBridge)
      .mockResolvedValueOnce(replacementBridge);
    const runtime = createRuntime(connectAcp);
    try {
      await runtime.waitForIdle();
      await expect(runtime.restartWorker('implementer')).rejects.toThrow(
        /saved session "old-session"/u,
      );
      expect(connectAcp).toHaveBeenCalledOnce();
      expect(runtime.getWorkerStatus('implementer')?.state).toBe('failed');

      await expect(runtime.restartWorker('implementer')).resolves.toBe('old-session');
      expect(oldBridge.close).toHaveBeenCalledTimes(2);
      expect(replacementBridge.loadSession).toHaveBeenCalledOnce();
    } finally {
      await runtime.shutdown();
    }
  });

  it('drains a delayed completion from the old ACP process before restarting the same ID', async () => {
    const connections: FakeConnection[] = [];
    const plans = [[], ['fake-session-1']];
    const inbox = new ConductorInbox();
    let releaseCompletion!: () => void;
    let completionStarted = false;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const completedSessionIds: string[] = [];
    inbox.subscribe(async (message) => {
      if (message.type !== 'worker.completed' || message.result.prompt !== 'previous turn') return;
      completionStarted = true;
      await completionGate;
      completedSessionIds.push(message.result.acpSessionId);
    });
    const onWorkerSessionRestarted = vi.fn(() => {
      expect(completedSessionIds).toEqual(['fake-session-1']);
    });
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () => {
        const connection = await connectFakeAcp(plans.shift() ?? []);
        connections.push(connection);
        return connection.bridge;
      },
      onWorkerSessionRestarted,
    });
    const workerId = runtime.start({
      name: 'implementer',
      kind: 'implementer',
      issueUrl: WORKTREE.issue.url,
      worktree: WORKTREE,
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
    });
    try {
      await runtime.waitForIdle();
      inbox.publishWorkerCompleted(workerId, {
        name: 'implementer',
        kind: 'implementer',
        issue: WORKTREE.issue,
        worktree: WORKTREE,
        prompt: 'previous turn',
        promptResult: { stopReason: 'end_turn' },
        acpSessionId: 'fake-session-1',
      });
      const restarting = runtime.restartWorker('implementer');
      await vi.waitFor(() => expect(completionStarted).toBe(true));
      expect(connections[0]?.close).not.toHaveBeenCalled();
      expect(connections).toHaveLength(1);
      releaseCompletion();
      await expect(restarting).resolves.toBe('fake-session-1');
      expect(onWorkerSessionRestarted).toHaveBeenCalledOnce();
    } finally {
      releaseCompletion();
      await runtime.shutdown();
      for (const connection of connections) connection.server.stop();
    }
  });

  it('keeps the saved ID retryable when the durable restart update fails', async () => {
    const connections: FakeConnection[] = [];
    const plans = [[], ['fake-session-1'], ['fake-session-1']];
    const onWorkerSessionRestarted = vi.fn()
      .mockRejectedValueOnce(new Error('resume store write failed'))
      .mockResolvedValue(undefined);
    const runtime = createRuntime(async () => {
      const connection = await connectFakeAcp(plans.shift() ?? []);
      connections.push(connection);
      return connection.bridge;
    }, { onWorkerSessionRestarted });
    try {
      await runtime.waitForIdle();
      await expect(runtime.restartWorker('implementer')).rejects.toThrow(
        /saved session "fake-session-1"/u,
      );
      expect(connections[1]?.loadedSessions).toEqual(['fake-session-1']);
      expect(connections[1]?.close).toHaveBeenCalledOnce();
      expect(runtime.getWorkerStatus('implementer')?.state).toBe('failed');

      await expect(runtime.restartWorker('implementer')).resolves.toBe('fake-session-1');
      expect(connections[2]?.loadedSessions).toEqual(['fake-session-1']);
      expect(onWorkerSessionRestarted).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.shutdown();
      for (const connection of connections) connection.server.stop();
    }
  });

  it('uses strict load for builtin Pi and refuses a missing session map', async () => {
    const connections: FakeConnection[] = [];
    const plans = [[], []];
    const runtime = new WorkerRuntime({ inbox: new ConductorInbox(), connectAcp: async () => {
      const connection = await connectFakeAcp(plans.shift() ?? []);
      connections.push(connection);
      return connection.bridge;
    } });
    runtime.start({
      name: 'implementer',
      kind: 'implementer',
      issueUrl: WORKTREE.issue.url,
      worktree: WORKTREE,
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
      acpFingerprint: {
        preset: 'pi',
        piRuntime: 'builtin',
        command: 'pi-acp-builtin',
        args: [],
      },
    });
    try {
      await runtime.waitForIdle();
      await expect(runtime.restartWorker('implementer')).rejects.toThrow(
        /could not be restarted with saved session "fake-session-1"/u,
      );
      expect(connections[1]?.loadedSessions).toEqual(['fake-session-1']);
      expect(connections[1]?.newSessions).toEqual([]);
      expect(runtime.getWorkerStatus('implementer')?.state).toBe('failed');
    } finally {
      // A failed strict load closes its own candidate; shutdown has no resident.
      await runtime.shutdown();
      for (const connection of connections) connection.server.stop();
    }
  });

  it('rejects processing and queued work without cancelling or closing the old session', async () => {
    let releasePrompt!: () => void;
    const firstPrompt = new Promise<{ stopReason: string }>((resolve) => {
      releasePrompt = () => resolve({ stopReason: 'end_turn' });
    });
    const bridge = {
      newSession: vi.fn().mockResolvedValue('known-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn()
        .mockResolvedValueOnce({ stopReason: 'end_turn' })
        .mockReturnValueOnce(firstPrompt)
        .mockResolvedValueOnce({ stopReason: 'end_turn' }),
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridgeType;
    const connectAcp = vi.fn().mockResolvedValue(bridge);
    const runtime = createRuntime(connectAcp);
    try {
      await runtime.waitForIdle();
      runtime.sendWorkerMessage('implementer', 'long task');
      runtime.sendWorkerMessage('implementer', 'queued task');
      await expect(runtime.restartWorker('implementer')).rejects.toThrow(
        /processing or has queued work/u,
      );
      expect(bridge.cancelSession).not.toHaveBeenCalled();
      expect(bridge.close).not.toHaveBeenCalled();
      releasePrompt();
      await runtime.waitForIdle();
      expect(bridge.promptSession).toHaveBeenCalledTimes(3);
      expect(connectAcp).toHaveBeenCalledOnce();
    } finally {
      await runtime.shutdown();
    }
  });

  it('gates prompts and competing transitions while restarting, then closes late candidates on shutdown', async () => {
    const connections: FakeConnection[] = [];
    const candidateGate: { resolve?: (connection: FakeConnection) => void } = {};
    const connectAcp = vi.fn(async () => {
      if (connections.length === 0) {
        const connection = await connectFakeAcp([]);
        connections.push(connection);
        return connection.bridge;
      }
      const connection = await new Promise<FakeConnection>((resolve) => {
        candidateGate.resolve = resolve;
      });
      connections.push(connection);
      return connection.bridge;
    });
    const runtime = createRuntime(connectAcp);
    await runtime.waitForIdle();
    const restarting = runtime.restartWorker('implementer');
    await vi.waitFor(() => expect(connectAcp).toHaveBeenCalledTimes(2));

    expect(runtime.sendWorkerMessage('implementer', 'blocked')).toMatchObject({
      status: 'error',
    });
    await expect(runtime.restartWorker('implementer')).rejects.toThrow(/busy/u);
    await expect(runtime.recreateWorker('implementer', 'fake-session-1')).rejects.toThrow(/busy/u);
    expect(runtime.getWorkerStatus('implementer')?.state).toBe('attaching');

    await expect(runtime.shutdown({ force: true })).rejects.toThrow(/shutdown failed/u);
    const candidate = await connectFakeAcp(['fake-session-1']);
    candidateGate.resolve?.(candidate);
    await expect(restarting).rejects.toThrow(/Shutdown/u);
    await runtime.waitForIdle();
    expect(candidate.close).toHaveBeenCalledOnce();
    candidate.server.stop();
    for (const connection of connections) connection.server.stop();
  });

  it('rejects restart when an attaching worker has no stable session state', async () => {
    let resolveConnection!: (bridge: AcpBridgeType) => void;
    const connectAcp = vi.fn(
      () => new Promise<AcpBridgeType>((resolve) => { resolveConnection = resolve; }),
    );
    const runtime = createRuntime(connectAcp);
    try {
      await vi.waitFor(() => expect(connectAcp).toHaveBeenCalledOnce());
      await expect(runtime.restartWorker('implementer')).rejects.toThrow(/busy/u);
      expect(runtime.sendWorkerMessage('implementer', 'queued while attaching')).toMatchObject({
        status: 'queued',
      });
      const bridge = {
        newSession: vi.fn().mockResolvedValue('known-session'),
        loadSession: vi.fn(),
        promptSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as AcpBridgeType;
      resolveConnection(bridge);
      await runtime.waitForIdle();
      expect(bridge.promptSession).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.shutdown();
    }
  });

  it('waits for an attach failure cleanup already in flight before opening a new process', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const firstBridge = {
      newSession: vi.fn().mockResolvedValue('lazy-session'),
      loadSession: vi.fn(),
      promptSession: vi.fn(),
      close: vi.fn(() => closeGate),
    } as unknown as AcpBridgeType;
    const restartedBridge = {
      newSession: vi.fn(),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridgeType;
    const connectAcp = vi.fn()
      .mockResolvedValueOnce(firstBridge)
      .mockResolvedValueOnce(restartedBridge);
    const runtime = new WorkerRuntime({
      inbox: new ConductorInbox(),
      connectAcp,
      onWorkerSessionAttached: vi.fn().mockRejectedValue(new Error('ID save failed')),
    });
    runtime.start({
      name: 'implementer',
      kind: 'implementer',
      issueUrl: WORKTREE.issue.url,
      worktree: WORKTREE,
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
    }, { lazy: true });
    runtime.sendWorkerMessage('implementer', 'start attach');
    try {
      await vi.waitFor(() => expect(firstBridge.close).toHaveBeenCalledOnce());
      const restarting = runtime.restartWorker('implementer');
      await Promise.resolve();
      expect(connectAcp).toHaveBeenCalledOnce();

      releaseClose();
      await expect(restarting).resolves.toBe('lazy-session');
      await runtime.waitForIdle();
      expect(connectAcp).toHaveBeenCalledTimes(2);
      expect(restartedBridge.loadSession).toHaveBeenCalledOnce();
    } finally {
      releaseClose();
      await runtime.shutdown();
    }
  });

  it('reports a newly created session ID before the first lazy init prompt', async () => {
    const firstBridge = {
      newSession: vi.fn().mockResolvedValue('lazy-session'),
      loadSession: vi.fn(),
      promptSession: vi.fn().mockRejectedValue(new Error('init failed')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridgeType;
    const restartedBridge = {
      newSession: vi.fn(),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridgeType;
    const onWorkerSessionAttached = vi.fn().mockResolvedValue(undefined);
    const runtime = new WorkerRuntime({
      inbox: new ConductorInbox(),
      connectAcp: vi.fn()
        .mockResolvedValueOnce(firstBridge)
        .mockResolvedValueOnce(restartedBridge),
      onWorkerSessionAttached,
    });
    runtime.start({
      name: 'implementer',
      kind: 'implementer',
      issueUrl: WORKTREE.issue.url,
      worktree: WORKTREE,
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
    }, { lazy: true });

    runtime.sendWorkerMessage('implementer', 'first instruction');
    await runtime.waitForIdle();
    expect(onWorkerSessionAttached).toHaveBeenCalledWith(expect.objectContaining({
      acpSessionId: 'lazy-session',
    }));
    expect(firstBridge.promptSession).toHaveBeenCalledOnce();
    expect(runtime.getWorkerStatus('implementer')?.state).toBe('failed');
    await expect(runtime.restartWorker('implementer')).resolves.toBe('lazy-session');
    expect(restartedBridge.loadSession).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it('refuses to guess an ID when the initial attach failed before session creation', async () => {
    const runtime = createRuntime(async () => {
      throw new Error('ACP could not start');
    });
    await runtime.waitForIdle();
    await expect(runtime.restartWorker('implementer')).rejects.toThrow(
      /no confirmed ACP session ID/u,
    );
    await runtime.shutdown();
  });
});
