import { describe, expect, it } from 'vitest';
import { JsonRpcPeer } from '../json-rpc-peer.js';
import { createInProcessStreamPair } from './stream-pair.js';
import { startFakeAcpServer } from './fake-acp-server.js';

describe('FakeAcpServer', () => {
  it('handles initialize → authenticate → session/new → session/prompt', async () => {
    const streams = createInProcessStreamPair();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      onPrompt: ({ notify }) => {
        notify('session/update', {
          sessionId: 'ignored',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello from fake' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    const updates: string[] = [];
    const peer = new JsonRpcPeer({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
      onNotification: (notification) => {
        if (notification.method === 'session/update') {
          const text = (
            notification.params as {
              update?: { content?: { text?: string } };
            }
          )?.update?.content?.text;
          if (text) updates.push(text);
        }
      },
    });

    await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    await peer.request('authenticate', { methodId: 'cursor_login' });
    const session = (await peer.request('session/new', {
      cwd: '/tmp',
      mcpServers: [],
    })) as { sessionId: string };
    const result = (await peer.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })) as { stopReason: string };

    expect(session.sessionId).toMatch(/^fake-session-/);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toContain('hello from fake');

    peer.close();
  });
});
