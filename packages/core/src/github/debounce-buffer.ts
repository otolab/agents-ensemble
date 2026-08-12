export interface DebounceBufferOptions<T> {
  debounceMs: number;
  onFlush: (items: T[]) => void;
  shutdownSignal?: AbortSignal;
}

/** 連続到着をまとめて 1 回だけ flush するバッファ。 */
export class DebounceBuffer<T> {
  private readonly debounceMs: number;
  private readonly onFlush: (items: T[]) => void;
  private readonly shutdownSignal?: AbortSignal;
  private items: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(options: DebounceBufferOptions<T>) {
    this.debounceMs = options.debounceMs;
    this.onFlush = options.onFlush;
    this.shutdownSignal = options.shutdownSignal;
    this.shutdownSignal?.addEventListener('abort', () => {
      this.flush();
    });
  }

  push(item: T): void {
    if (this.stopped) return;
    this.items.push(item);
    this.scheduleFlush();
  }

  pushMany(items: T[]): void {
    if (this.stopped || items.length === 0) return;
    this.items.push(...items);
    this.scheduleFlush();
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.items.length === 0) return;
    const batch = this.items;
    this.items = [];
    this.onFlush(batch);
  }

  stop(): void {
    this.stopped = true;
    this.flush();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  get pendingCount(): number {
    return this.items.length;
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
  }
}
