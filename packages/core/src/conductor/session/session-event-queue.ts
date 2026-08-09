import type { SessionEvent } from './session-event.js';

/** ConductorSession の単一イベント列（旧 inbox + conductor Queue の統合）。 */
export class SessionEventQueue {
  private readonly queue: SessionEvent[] = [];
  private readonly waiters: Array<(event: SessionEvent) => void> = [];

  get size(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  enqueue(event: SessionEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  dequeue(): SessionEvent | undefined {
    return this.queue.shift();
  }

  async waitForEvent(signal?: AbortSignal): Promise<SessionEvent> {
    const pending = this.dequeue();
    if (pending) {
      return pending;
    }
    if (signal?.aborted) {
      throw new DOMException('Session event wait aborted', 'AbortError');
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new DOMException('Session event wait aborted', 'AbortError'));
      };
      const waiter = (event: SessionEvent) => {
        cleanup();
        resolve(event);
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      signal?.addEventListener('abort', onAbort);
      this.waiters.push(waiter);
    });
  }
}
