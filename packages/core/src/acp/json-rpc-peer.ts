import type { Readable, Writable } from 'node:stream';
import { NdJsonLineBuffer, parseMessage, serializeMessage } from './json-rpc.js';
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from './json-rpc.js';

export type NotificationHandler = (notification: JsonRpcNotification) => void;
export type RequestHandler = (request: JsonRpcRequest) => void | Promise<void>;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface JsonRpcPeerOptions {
  readable: Readable;
  writable: Writable;
  onNotification?: NotificationHandler;
  /** Agent-initiated requests (e.g. session/request_permission). */
  onRequest?: RequestHandler;
}

/**
 * Client-side JSON-RPC peer over newline-delimited stdio.
 * Matches the transport used by `agent acp` (see Cursor ACP docs).
 */
export class JsonRpcPeer {
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly pendingWrites = new Set<(error: Error) => void>();
  private readonly lineBuffer = new NdJsonLineBuffer();
  private nextId = 1;
  private closed = false;
  private readableError?: Error;

  constructor(private readonly options: JsonRpcPeerOptions) {
    options.readable.setEncoding('utf8');
    options.readable.on('data', (chunk: string) => this.handleChunk(chunk));
    options.readable.on('end', () =>
      this.failReadable(new Error('JSON-RPC stream ended')),
    );
    options.readable.on('error', (error: Error) => this.failReadable(error));
    options.writable.on('error', (error: Error) => this.fail(error));
    options.writable.on('close', () => {
      if (!this.closed) {
        this.fail(new Error('JSON-RPC writable stream closed'));
      }
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return observeRejection(
        Promise.reject(new Error('JSON-RPC peer is closed')),
      );
    }
    if (this.readableError) {
      return observeRejection(Promise.reject(this.readableError));
    }

    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message = { jsonrpc: '2.0' as const, id, method, params };
      void this.write(message).catch((error: unknown) => {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        waiter.reject(toError(error));
      });
    });
    return observeRejection(response);
  }

  respond(id: number | string, result: unknown): Promise<void> {
    return observeRejection(this.write({ jsonrpc: '2.0', id, result }));
  }

  notify(method: string, params?: unknown): Promise<void> {
    return observeRejection(this.write({ jsonrpc: '2.0', method, params }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('JSON-RPC peer closed');
    this.rejectAll(error);
    this.rejectWrites(error);
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
      void this.handleRequest(message as JsonRpcRequest);
      return;
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      await this.options.onRequest?.(request);
    } catch (error) {
      // A request handler failure means the transport can no longer complete
      // the current request. Close the peer so pending calls fail as well,
      // while keeping the rejection out of the process-level event loop.
      this.fail(error);
    }
  }

  private write(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('JSON-RPC peer is closed'));
    }

    let serialized: string;
    try {
      serialized = serializeMessage(message);
    } catch (error) {
      return Promise.reject(toError(error));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let rejectWrite: (error: Error) => void;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        this.pendingWrites.delete(rejectWrite);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      rejectWrite = (error) => finish(error);
      this.pendingWrites.add(rejectWrite);

      try {
        this.options.writable.write(serialized, (error?: Error | null) => {
          if (error) {
            const writeError = toError(error);
            this.fail(writeError);
            finish(writeError);
            return;
          }
          finish();
        });
      } catch (error) {
        const writeError = toError(error);
        this.fail(writeError);
        finish(writeError);
      }
    });
  }

  private fail(error: unknown): void {
    const normalized = toError(error);
    if (!this.closed) {
      this.closed = true;
      this.rejectAll(normalized);
    }
    this.rejectWrites(normalized);
  }

  private failReadable(error: unknown): void {
    if (this.readableError) return;
    // ACP requests are read from this stream, but responses are written to a
    // separate stream. Keep the writable side available for an in-flight
    // agent request (notably permission cleanup) after readable failure.
    this.readableError = toError(error);
    this.rejectAll(this.readableError);
  }

  private rejectWrites(error: Error): void {
    for (const reject of this.pendingWrites) {
      reject(error);
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function observeRejection<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {
    // Preserve the rejected Promise for callers while preventing an ignored
    // write result from becoming a process-level unhandled rejection.
  });
  return promise;
}
