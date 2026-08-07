import type { Readable, Writable } from 'node:stream';
import { NdJsonLineBuffer, parseMessage, serializeMessage } from './json-rpc.js';
import type { JsonRpcMessage, JsonRpcNotification } from './json-rpc.js';

export type NotificationHandler = (notification: JsonRpcNotification) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface JsonRpcPeerOptions {
  readable: Readable;
  writable: Writable;
  onNotification?: NotificationHandler;
}

/**
 * Client-side JSON-RPC peer over newline-delimited stdio.
 * Matches the transport used by `agent acp` (see Cursor ACP docs).
 */
export class JsonRpcPeer {
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly lineBuffer = new NdJsonLineBuffer();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: JsonRpcPeerOptions) {
    options.readable.setEncoding('utf8');
    options.readable.on('data', (chunk: string) => this.handleChunk(chunk));
    options.readable.on('end', () => this.rejectAll(new Error('JSON-RPC stream ended')));
    options.readable.on('error', (error: Error) => this.rejectAll(error));
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error('JSON-RPC peer is closed');
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message = { jsonrpc: '2.0' as const, id, method, params };
      this.options.writable.write(serializeMessage(message));
    });
  }

  respond(id: number | string, result: unknown): void {
    this.options.writable.write(
      serializeMessage({ jsonrpc: '2.0', id, result }),
    );
  }

  notify(method: string, params?: unknown): void {
    this.options.writable.write(
      serializeMessage({ jsonrpc: '2.0', method, params }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('JSON-RPC peer closed'));
  }

  private handleChunk(chunk: string): void {
    for (const line of this.lineBuffer.push(chunk)) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const message = parseMessage(line);

    if ('id' in message && ('result' in message || 'error' in message)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if ('method' in message && !('id' in message)) {
      this.options.onNotification?.(message);
      return;
    }

    if ('method' in message && 'id' in message) {
      // Server-side request from agent (e.g. session/request_permission).
      // Handled by FakeAcpServer on the other end; clients use onNotification + respond.
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}
