import { PassThrough } from 'node:stream';
import type { OperatorAgentInput } from '../../src/run-operator-agent.js';

export function createInteractiveInput(): PassThrough &
  OperatorAgentInput & { endWhenReady: () => void } {
  class InteractivePassThrough extends PassThrough {
    isRaw = false;
    private readonly pendingKeys: Array<{
      readonly key: string;
      readonly encoding?: BufferEncoding;
      readonly callback?: (error?: Error | null) => void;
    }> = [];
    private pendingEnd = false;
    private pendingEndCallback?: (error?: Error | null) => void;
    private flushScheduled = false;

    override write(
      chunk: Uint8Array | string,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      const encoding =
        typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
      const done =
        typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : callback;
      if (typeof chunk !== 'string') {
        return typeof encoding === 'string'
          ? super.write(chunk, encoding, done)
          : super.write(chunk, done);
      }

      const keys =
        chunk.startsWith('\u001b[200~') && chunk.endsWith('\u001b[201~')
          ? [chunk]
          : (chunk.match(
              /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[NO][ -~]|\r\n|\r|\n|./gsu,
            ) ?? []);
      const terminalKeys = keys.map((key) =>
        key === '\n' || key === '\r\n' ? '\r' : key,
      );
      terminalKeys.forEach((key, index) => {
        const keyCallback = index === terminalKeys.length - 1 ? done : undefined;
        this.pendingKeys.push({
          key,
          ...(encoding ? { encoding } : {}),
          ...(keyCallback ? { callback: keyCallback } : {}),
        });
      });
      this.scheduleFlush();
      return true;
    }

    override end(
      chunk?: Uint8Array | string | (() => void),
      encodingOrCallback?:
        | BufferEncoding
        | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): this {
      if (chunk !== undefined) {
        this.write(
          chunk as Uint8Array | string,
          encodingOrCallback as BufferEncoding | undefined,
          callback,
        );
      }
      this.pendingEndCallback =
        typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : callback;
      this.pendingEnd = true;
      this.scheduleFlush();
      return this;
    }

    flushPending(): void {
      if (!this.isRaw) return;
      const nextKey = this.pendingKeys.shift();
      if (nextKey) {
        if (nextKey.encoding) {
          super.write(nextKey.key, nextKey.encoding, nextKey.callback);
        } else {
          super.write(nextKey.key, nextKey.callback);
        }
        this.scheduleFlush();
        return;
      }
      if (this.pendingEnd) {
        this.pendingEnd = false;
        super.end(this.pendingEndCallback);
        this.pendingEndCallback = undefined;
      }
    }

    endWhenReady(): void {
      this.end();
    }

    private scheduleFlush(): void {
      if (!this.isRaw || this.flushScheduled) return;
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        this.flushPending();
      });
    }
  }

  const input = new InteractivePassThrough() as InteractivePassThrough &
    OperatorAgentInput & {
      endWhenReady: () => void;
      flushPending: () => void;
      ref: () => void;
      unref: () => void;
    };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
    if (mode) setImmediate(() => input.flushPending());
    return input;
  };
  input.ref = () => {};
  input.unref = () => {};
  return input;
}
