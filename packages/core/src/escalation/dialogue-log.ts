export type DialogueEntryKind = 'operator_message' | 'registry_update';

export interface DialogueEntry {
  at: number;
  turn?: number;
  kind: DialogueEntryKind;
  text: string;
}

/** オペレータ入力と registry 更新報告の時系列（prompt には載せない。セッション結果用）。 */
export class SessionDialogueLog {
  private readonly entries: DialogueEntry[] = [];

  appendOperatorMessage(turn: number, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.push({
      at: Date.now(),
      turn,
      kind: 'operator_message',
      text: trimmed,
    });
  }

  appendRegistryUpdate(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.push({
      at: Date.now(),
      kind: 'registry_update',
      text: trimmed,
    });
  }

  list(): DialogueEntry[] {
    return [...this.entries];
  }
}
