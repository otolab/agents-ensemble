import type { OpenQuestion } from '../escalation/open-question.js';

export interface OperatorInputContext {
  /** これから実行する conductor send 番号（1 始まり）。 */
  conductorTurn: number;
  autonomousTurns: number;
  /** 無制限時は `null`。 */
  maxTurns: number | null;
  openQuestions: OpenQuestion[];
}

export interface OperatorInputSubmitOptions {
  /** TUI で選択中の open question への回答先。未指定時は従来どおり件数で解釈。 */
  targetOpenQuestionId?: string;
}

export interface OperatorInputBindingApi {
  submit: (message: string, options?: OperatorInputSubmitOptions) => boolean;
  getContext: () => OperatorInputContext;
}

/** 非ブロッキングのオペレータ入力源。戻り値で購読を解除する。 */
export type OperatorInputBinding = (
  api: OperatorInputBindingApi,
) => void | (() => void);
