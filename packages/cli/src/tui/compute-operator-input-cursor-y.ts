import stringWidth from 'string-width';
import {
  INPUT_PANE_BORDER_ROWS,
  INPUT_PANE_LEFT_COLUMNS,
  OPEN_QUESTIONS_PANE_HEIGHT,
  PANE_BORDER_ROWS,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';

/** 入力ペインの総行数（枠線 + ヒント行 + 入力行）。Ink `Box` の `height` に渡す値。 */
export function computeInputPaneHeight(hintLineCount: number): number {
  return INPUT_PANE_BORDER_ROWS + hintLineCount + 1;
}

/** Session ペイン（flexGrow）の行数。全ペイン高さの合計が端末行数と一致するよう逆算。 */
export function computeActivityPaneHeight(params: {
  terminalRows: number;
  hintLineCount: number;
}): number {
  return (
    params.terminalRows -
    WORKER_PANE_HEIGHT -
    OPEN_QUESTIONS_PANE_HEIGHT -
    computeInputPaneHeight(params.hintLineCount)
  );
}

/** Session ペインに収まる活動ログ行数（タイトル行・枠線を除く）。 */
export function computeActivityLogLineCapacity(params: {
  terminalRows: number;
  hintLineCount: number;
}): number {
  return Math.max(0, computeActivityPaneHeight(params) - PANE_BORDER_ROWS - 1);
}

/** 入力行先頭（`operator> ` の直後）の X 座標。左枠線 + padding + プロンプト幅。 */
export function computeOperatorInputCursorX(operatorPrompt: string): number {
  return INPUT_PANE_LEFT_COLUMNS + stringWidth(operatorPrompt);
}

/**
 * オペレータ入力行の Y 座標（Ink 出力原点から 0 始まり）。
 * 本番は `useBoxMetrics` で実測する。ユニットテスト用の式。
 */
export function computeOperatorInputCursorY(params: {
  terminalRows: number;
  hintLineCount: number;
}): number {
  const panesAboveInput =
    WORKER_PANE_HEIGHT +
    computeActivityPaneHeight(params) +
    OPEN_QUESTIONS_PANE_HEIGHT;

  return panesAboveInput + PANE_BORDER_ROWS / 2 + params.hintLineCount;
}
