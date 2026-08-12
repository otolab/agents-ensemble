/** Worker 状態ペインの固定高さ（`issue-session-tui` の `height` と一致）。 */
export const WORKER_PANE_HEIGHT = 6;

/** Open questions ペインの固定高さ。 */
export const OPEN_QUESTIONS_PANE_HEIGHT = 4;

/** 入力ペインの枠線（上下）行数。 */
export const INPUT_PANE_BORDER_ROWS = 2;

/**
 * オペレータ入力行の Y 座標（Ink 出力原点から 0 始まり）。
 * ペイン高さが固定されている前提で、ヒント行数から入力ペイン高を逆算する。
 */
export function computeOperatorInputCursorY(params: {
  terminalRows: number;
  hintLineCount: number;
}): number {
  const inputContentRows = params.hintLineCount + 1;
  const inputPaneHeight = INPUT_PANE_BORDER_ROWS + inputContentRows;
  const activityPaneHeight =
    params.terminalRows -
    WORKER_PANE_HEIGHT -
    OPEN_QUESTIONS_PANE_HEIGHT -
    inputPaneHeight;

  return (
    WORKER_PANE_HEIGHT +
    activityPaneHeight +
    OPEN_QUESTIONS_PANE_HEIGHT +
    1 +
    params.hintLineCount
  );
}
