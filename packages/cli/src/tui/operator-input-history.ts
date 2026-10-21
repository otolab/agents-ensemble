/** TTY Operator input の送信履歴と、履歴移動中の未送信ドラフトを管理する。 */
export class OperatorInputHistory {
  private readonly entries: string[] = [];
  /** -1 は履歴から編集した内容を送信した直後の空欄を表す。 */
  private browsingIndex: number | null = null;
  private draft = '';

  submit(value: string): void {
    this.entries.unshift(value);
    if (this.browsingIndex !== null) {
      // 履歴を編集して送信しても、移動開始時に退避したドラフトは ↓ で復元できる。
      this.browsingIndex = -1;
      return;
    }
    this.draft = '';
  }

  older(currentValue: string): string | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }

    const nextIndex = this.browsingIndex === null ? 0 : this.browsingIndex + 1;
    if (nextIndex < 0 || nextIndex >= this.entries.length) {
      return undefined;
    }
    if (this.browsingIndex === null) {
      this.draft = currentValue;
    }
    this.browsingIndex = nextIndex;
    return this.entries[nextIndex];
  }

  newer(): string | undefined {
    if (this.browsingIndex === null) {
      return undefined;
    }
    if (this.browsingIndex > 0) {
      this.browsingIndex--;
      return this.entries[this.browsingIndex];
    }

    this.browsingIndex = null;
    const draft = this.draft;
    this.draft = '';
    return draft;
  }

  /** 送信直後の空欄から新しく入力し始めたら、保留中のドラフト復帰を終える。 */
  abandonDeferredDraftOnInput(): void {
    if (this.browsingIndex === -1) {
      this.browsingIndex = null;
      this.draft = '';
    }
  }
}
