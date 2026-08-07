import { describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp-client.js';
import { createInProcessStreamPair } from './testing/stream-pair.js';
import { startFakeAcpServer } from './testing/fake-acp-server.js';

describe('AcpClient', () => {
  it('runs connect → newSession → prompt', async () => {
    const streams = createInProcessStreamPair();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      onPrompt: ({ notify }) => {
        notify('session/update', {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'done' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    const updates: string[] = [];
    const result = await client.prompt(sessionId, 'hello', (update) => {
      const text = update.update?.content?.text;
      if (text) updates.push(text);
    });

    expect(sessionId).toMatch(/^fake-session-/);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toContain('done');

    await client.close();
  });

  it('responds to session/request_permission', async () => {
    const streams = createInProcessStreamPair();
    const permissionHandler = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
    });

    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      { permissionHandler },
    );

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    const result = await client.prompt(sessionId, 'run tool');

    expect(result.stopReason).toBe('end_turn');
    expect(permissionHandler).toHaveBeenCalledOnce();

    await client.close();
  });
});
