import {
  INPUT_PANE_BORDER_ROWS,
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

/**
 * オペレータ入力行の Y 座標（Ink 出力原点から 0 始まり）。
 *
 * 各 `height` は枠線込み（Yoga border-box）。入力ペイン内では
 * 上枠 1 行 → ヒント `hintLineCount` 行 → 入力行 の順。
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
