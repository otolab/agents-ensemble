import { describe, expect, it, vi } from 'vitest';
import { AcpBridge } from './acp-bridge.js';
import { AcpClient } from './acp-client.js';
import { createInProcessStreamPair } from './testing/stream-pair.js';
import { startFakeAcpServer } from './testing/fake-acp-server.js';

describe('AcpBridge session resume', () => {
  it('loads an existing session id before prompting', async () => {
    const streams = createInProcessStreamPair();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
    });

    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });
    await client.connect();
    const bridge = AcpBridge.fromClient(client);

    const first = await bridge.runSession({
      cwd: '/tmp/worktree',
      prompt: 'first',
    });
    expect(first.sessionId).toMatch(/^fake-session-/);

    const second = await bridge.runSession({
      cwd: '/tmp/worktree',
      prompt: 'second',
      resumeSessionId: first.sessionId,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.promptResult.stopReason).toBe('end_turn');
    await client.close();
  });

  it('falls back to a new session when load fails', async () => {
    const streams = createInProcessStreamPair();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
    });

    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });
    await client.connect();
    const bridge = AcpBridge.fromClient(client);

    const result = await bridge.runSession({
      cwd: '/tmp/worktree',
      prompt: 'fresh',
      resumeSessionId: 'missing-session',
    });

    expect(result.sessionId).toMatch(/^fake-session-/);
    await client.close();
  });

  it('does not replace a resumed session when its configured option cannot be applied', async () => {
    const streams = createInProcessStreamPair();
    const onNewSession = vi.fn();
    const onLoadSession = vi.fn();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      initialSessions: ['resume-session'],
      onNewSession,
      onLoadSession,
      sessionConfigOptions: [
        {
          id: 'effort',
          type: 'select',
          currentValue: 'low',
          options: [{ value: 'low', name: 'Low' }],
        },
      ],
    });

    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      {
        sessionConfigOptionOverrides: [{ id: 'effort', value: 'high' }],
      },
    );
    await client.connect();
    const bridge = AcpBridge.fromClient(client);

    await expect(
      bridge.runSession({
        cwd: '/tmp/worktree',
        prompt: 'must not run',
        resumeSessionId: 'resume-session',
      }),
    ).rejects.toThrow(/does not advertise "high" for session config option "effort"/);

    expect(onLoadSession).toHaveBeenCalledOnce();
    expect(onNewSession).not.toHaveBeenCalled();
    await client.close();
  });
});
