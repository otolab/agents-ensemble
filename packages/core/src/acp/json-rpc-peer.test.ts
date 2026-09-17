import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { JsonRpcPeer } from './json-rpc-peer.js';
import { serializeMessage } from './json-rpc.js';

describe('JsonRpcPeer', () => {
  it('rejects pending requests but keeps the response path after readable end', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();

    const peer = new JsonRpcPeer({ readable, writable });
    const pending = peer.request('initialize', {});

    readable.end();

    await expect(pending).rejects.toThrow('JSON-RPC stream ended');
    await expect(peer.respond(1, { ok: true })).resolves.toBeUndefined();
    peer.close();
  });

  it('handles agent-initiated requests via onRequest', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    readable.setEncoding('utf8');

    const peer = new JsonRpcPeer({
      readable,
      writable,
      onRequest: async (request) => {
        await peer.respond(request.id, { ok: true });
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

  it('rejects respond when the writable is destroyed', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const peer = new JsonRpcPeer({ readable, writable });
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    writable.destroy(error);

    await expect(peer.respond(1, { ok: true })).rejects.toThrow('write EPIPE');
    peer.close();
  });

  it('rejects requests when the writable emits a transport error', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const peer = new JsonRpcPeer({ readable, writable });
    const pending = peer.request('session/prompt', {});
    const error = Object.assign(new Error('write ECONNRESET'), {
      code: 'ECONNRESET',
    });

    writable.destroy(error);

    await expect(pending).rejects.toThrow('write ECONNRESET');
  });

  it('rejects notifications when the writable is destroyed', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const peer = new JsonRpcPeer({ readable, writable });

    writable.destroy();

    await expect(peer.notify('session/cancel', {})).rejects.toThrow();
  });

  it('contains a failed response from the onRequest path', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    let peer: JsonRpcPeer;
    const onRequest = vi.fn((request: { id: number | string }) => {
      peer.respond(request.id, { ok: true });
    });
    peer = new JsonRpcPeer({ readable, writable, onRequest });
    const pending = peer.request('session/prompt', {});
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    writable.destroy(error);
    readable.write(
      serializeMessage({
        jsonrpc: '2.0',
        id: 99,
        method: 'session/request_permission',
        params: { toolName: 'shell' },
      }),
    );

    expect(onRequest).toHaveBeenCalledOnce();
    await expect(pending).rejects.toThrow('write EPIPE');
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
