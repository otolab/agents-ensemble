import type { OpenQuestion } from '../escalation/open-question.js';

export interface OperatorInputContext {
  /** これから実行する conductor send 番号（1 始まり）。 */
  conductorTurn: number;
  autonomousTurns: number;
  /** 無制限時は `null`。 */
  maxTurns: number | null;
  openQuestions: OpenQuestion[];
}

export interface OperatorInputBindingApi {
  submit: (message: string) => boolean;
  getContext: () => OperatorInputContext;
}

/** 非ブロッキングのオペレータ入力源。戻り値で購読を解除する。 */
export type OperatorInputBinding = (
  api: OperatorInputBindingApi,
) => void | (() => void);
