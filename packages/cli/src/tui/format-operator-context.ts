import type { OperatorInputContext } from '@agents-ensemble/core';

function formatMaxTurnsLabel(maxTurns: number | null): string {
  return maxTurns === null ? '∞' : String(maxTurns);
}

export interface OpenQuestionSelectionContext {
  id: string;
  index: number;
  total: number;
}

/** 入力欄直上に表示するオペレータ向けコンテキスト行。 */
export function formatOperatorContextHint(
  context: OperatorInputContext | undefined,
  selection?: OpenQuestionSelectionContext,
): string {
  if (!context) {
    return 'operator> ';
  }

  if (context.openQuestions.length > 0) {
    if (selection) {
      return `${selection.id} (${selection.index + 1}/${selection.total}) への回答 — Shift+↑↓で選択 · Enter で送信`;
    }
    return 'open question あり — Shift+↑↓で選択して回答';
  }

  return `自律ターン ${context.autonomousTurns}/${formatMaxTurnsLabel(context.maxTurns)} — 任意のタイミングで入力（/exit で終了）`;
}
