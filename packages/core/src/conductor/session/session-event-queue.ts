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

  async waitForEvent(): Promise<SessionEvent> {
    const pending = this.dequeue();
    if (pending) {
      return pending;
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
