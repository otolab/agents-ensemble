import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      userInstructions: {
        id: 'user-instructions',
        title: 'User instructions (~/.ensemble/AGENTS.md)',
        content: 'Shared guidance for every worker kind.',
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
    expect(completed[0]?.prompt).toContain(
      '### User instructions (~/.ensemble/AGENTS.md)',
    );
    expect(completed[0]?.prompt).toContain(
      'Shared guidance for every worker kind.',
    );
    expect(session.runtime.attachedCount).toBe(1);
    expect(session.runtime.getAttached('ping-1')?.session.sessionId).toBeTruthy();

    await session.stop();
    expect(session.runtime.attachedCount).toBe(0);
  });

  it('waits for the owned ACP child to exit during force stop', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'worker-acp-stop-'));
    const serverPath = join(fixtureDir, 'fake-acp-server.cjs');
    const pidPath = join(fixtureDir, 'acp-pids');
    await writeFile(
      serverPath,
      `
const fs = require('node:fs');
fs.writeFileSync(process.env.ACP_PID_FILE, String(process.pid));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf('\\n');
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    const message = JSON.parse(line);
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
    let result = {};
    if (message.method === 'initialize') {
      result = {
        protocolVersion: 1,
        agentCapabilities: { session: {} },
        agentInfo: { name: 'fixture-acp', version: '1.0.0' },
      };
    } else if (message.method === 'session/new') {
      result = { sessionId: 'fixture-session' };
    } else if (message.method === 'session/prompt') {
      result = { stopReason: 'end_turn' };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
setInterval(() => {}, 60_000);
`,
    );

    const session = new WorkerSession({
      issueUrl: TEST_ISSUE.url,
      worktree: { ...TEST_WORKTREE, path: fixtureDir },
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
      connectAcp: async ({ cwd }) =>
        AcpBridge.connect({
          cwd,
          command: process.execPath,
          args: [serverPath],
          env: { ...process.env, ACP_PID_FILE: pidPath },
        }),
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    });

    let stopped = false;
    try {
      session.startWorkers();
      await session.runtime.waitForIdle();
      await session.inbox.drain();

      const pid = Number(await readFile(pidPath, 'utf8'));
      expect(Number.isInteger(pid)).toBe(true);
      expect(isProcessAlive(pid)).toBe(true);

      await session.stop({ force: true });
      stopped = true;

      expect(session.runtime.attachedCount).toBe(0);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      try {
        if (!stopped) await session.stop({ force: true });
      } finally {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    }
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
