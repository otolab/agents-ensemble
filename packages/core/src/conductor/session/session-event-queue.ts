import type { SessionEvent } from './session-event.js';

/** ConductorSession の単一イベント列（旧 inbox + conductor Queue の統合）。 */
export class SessionEventQueue {
  private readonly queue: SessionEvent[] = [];
  private readonly waiters: Array<{
    accept: (event: SessionEvent) => boolean;
    resolve: (event: SessionEvent) => void;
    reject: (error: DOMException) => void;
  }> = [];

  get size(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  enqueue(event: SessionEvent): void {
    const waiterIndex = this.waiters.findIndex((waiter) =>
      waiter.accept(event),
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter!.resolve(event);
      return;
    }
    this.queue.push(event);
  }

  dequeue(): SessionEvent | undefined {
    return this.queue.shift();
  }

  /** キュー内容のスナップショット（到着順）。 */
  snapshot(): SessionEvent[] {
    return [...this.queue];
  }

  /** キュー全体を置き換える（dispatch 束の除去後など）。 */
  replaceQueue(next: SessionEvent[]): void {
    this.queue.length = 0;
    this.queue.push(...next);
  }

  /**
   * 先頭に挿入する（waiter 経由で取り出したイベントを到着順どおり戻すとき用）。
   * 新しい waiter は起こさない。
   */
  prependSilent(event: SessionEvent): void {
    this.queue.unshift(event);
  }

  /** 述語に合う最初の send イベントを取り出す（キュー順は維持）。 */
  findSendEvent(
    accept: (event: SessionEvent) => boolean,
  ): SessionEvent | undefined {
    const index = this.queue.findIndex((event) => accept(event));
    if (index < 0) {
      return undefined;
    }
    return this.queue.splice(index, 1)[0];
  }

  /** 条件に合う send event をすべて取り出し、残りの順序を保つ。 */
  findSendEvents(accept: (event: SessionEvent) => boolean): SessionEvent[] {
    const matched: SessionEvent[] = [];
    const retained: SessionEvent[] = [];
    for (const event of this.queue) {
      (accept(event) ? matched : retained).push(event);
    }
    this.replaceQueue(retained);
    return matched;
  }

  /**
   * `accept` に合う send イベントが来るまで待つ。
   * 合わないイベントはキュー末尾へ戻し、到着順を壊さない。
   *
   * @deprecated 本番 Driver は `waitForDispatchBatch`（ADR 0014）を使用。単体テスト用 legacy API。
   */
  async waitForSendEvent(input: {
    accept: (event: SessionEvent) => boolean;
    signal?: AbortSignal;
  }): Promise<SessionEvent> {
    for (;;) {
      const found = this.findSendEvent(input.accept);
      if (found) {
        return found;
      }

      const incoming = await this.waitForEvent(input.signal, {
        onlyNew: this.queue.length > 0,
      });
      if (input.accept(incoming)) {
        return incoming;
      }
      this.queue.push(incoming);
    }
  }

  async waitForEvent(
    signal?: AbortSignal,
    options?: { onlyNew?: boolean },
  ): Promise<SessionEvent> {
    if (!options?.onlyNew) {
      const pending = this.dequeue();
      if (pending) {
        return pending;
      }
    }
    if (signal?.aborted) {
      throw new DOMException('Session event wait aborted', 'AbortError');
    }
    return this.waitForIncomingEvent(() => true, signal);
  }

  /**
   * 条件に合う event を1件待つ。ほかの queue event は消費・並べ替えしない。
   * これにより conductor が close 済みの間も `/reconnect` を待ちながら、
   * その間に届く message や worker outcome を保持できる。
   */
  async waitForMatchingEvent(
    accept: (event: SessionEvent) => boolean,
    signal?: AbortSignal,
  ): Promise<SessionEvent> {
    const index = this.queue.findIndex(accept);
    if (index >= 0) {
      return this.queue.splice(index, 1)[0]!;
    }
    return this.waitForIncomingEvent(accept, signal);
  }

  private waitForIncomingEvent(
    accept: (event: SessionEvent) => boolean,
    signal?: AbortSignal,
  ): Promise<SessionEvent> {
    if (signal?.aborted) {
      return Promise.reject(
        new DOMException('Session event wait aborted', 'AbortError'),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        accept,
        resolve,
        reject: (error: DOMException) => reject(error),
      };
      const onAbort = () => {
        cleanup();
        waiter.reject(
          new DOMException('Session event wait aborted', 'AbortError'),
        );
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      const originalResolve = waiter.resolve;
      waiter.resolve = (event) => {
        cleanup();
        originalResolve(event);
      };
      signal?.addEventListener('abort', onAbort);
      this.waiters.push(waiter);
    });
  }
}
