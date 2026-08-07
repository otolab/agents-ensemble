import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { JsonRpcPeer } from './json-rpc-peer.js';
import { serializeMessage } from './json-rpc.js';

describe('JsonRpcPeer', () => {
  it('rejects pending requests when the stream ends', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();

    const peer = new JsonRpcPeer({ readable, writable });
    const pending = peer.request('initialize', {});

    readable.end();

    await expect(pending).rejects.toThrow('JSON-RPC stream ended');
  });

  it('handles agent-initiated requests via onRequest', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    readable.setEncoding('utf8');

    const peer = new JsonRpcPeer({
      readable,
      writable,
      onRequest: (request) => {
        peer.respond(request.id, { ok: true });
      },
    });

    readable.write(
      serializeMessage({
        jsonrpc: '2.0',
        id: 99,
        method: 'session/request_permission',
        params: { toolName: 'shell' },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const written = (writable.read() as Buffer | null)?.toString().trim();
    expect(written).toBe(
      JSON.stringify({ jsonrpc: '2.0', id: 99, result: { ok: true } }),
    );
  });
});
