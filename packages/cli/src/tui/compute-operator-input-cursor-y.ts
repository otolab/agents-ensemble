import stringWidth from 'string-width';
import {
  INPUT_PANE_BORDER_ROWS,
  INPUT_PANE_LEFT_COLUMNS,
  OPEN_QUESTIONS_PANE_HEIGHT,
  OPERATOR_INPUT_CURSOR_Y_OFFSET,
  ORCHESTRATION_PANE_TITLE_ROWS,
  PANE_BORDER_ROWS,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';

/** 入力ペインの総行数（枠線 + ヒント行 + 入力行）。Ink `Box` の `height` に渡す値。 */
export function computeInputPaneHeight(params: {
  hintLineCount: number;
  inputDisplayLineCount?: number;
}): number {
  const inputDisplayLineCount = Math.max(1, params.inputDisplayLineCount ?? 1);
  return INPUT_PANE_BORDER_ROWS + params.hintLineCount + inputDisplayLineCount;
}

/** Orchestration メインペインの行数。全ペイン高さの合計が端末行数と一致するよう逆算。 */
export function computeActivityPaneHeight(params: {
  terminalRows: number;
  hintLineCount: number;
  inputDisplayLineCount?: number;
}): number {
  return (
    params.terminalRows -
    WORKER_PANE_HEIGHT -
    OPEN_QUESTIONS_PANE_HEIGHT -
    computeInputPaneHeight({
      hintLineCount: params.hintLineCount,
      inputDisplayLineCount: params.inputDisplayLineCount,
    })
  );
}

/** Orchestration ペイン内に表示できる活動ログ行数。 */
export function computeOrchestrationLogVisibleLineCount(
  paneHeight: number,
  titleLineCount: number = ORCHESTRATION_PANE_TITLE_ROWS,
): number {
  return Math.max(1, paneHeight - PANE_BORDER_ROWS - titleLineCount);
}

/** 端末行数から Orchestration ペインの活動ログ行キャパシティ（タイトル 1 行想定）。 */
export function computeActivityLogLineCapacity(params: {
  terminalRows: number;
  hintLineCount: number;
  inputDisplayLineCount?: number;
}): number {
  const activityPaneHeight = computeActivityPaneHeight(params);
  return computeOrchestrationLogVisibleLineCount(activityPaneHeight);
}

/**
 * オペレータ入力カーソルの X 座標（Ink 出力原点から 0 始まり、カーソル offset 0）。
 * 入力ペインの左枠線・padding とプロンプト幅を含む。
 */
export function computeOperatorInputCursorX(operatorPrompt: string): number {
  return INPUT_PANE_LEFT_COLUMNS + stringWidth(operatorPrompt);
}

/**
 * オペレータ入力行の Y 座標（Ink `useCursor` 向け。Ink 出力原点から 0 始まり）。
 *
 * 描画フレーム上の入力行インデックスに {@link OPERATOR_INPUT_CURSOR_Y_OFFSET} を加算する。
 * Ink `log-update` の `visibleLineCount` と実入力行の差を補正（オペレータ手動確認 iTerm2+tmux）。
 */
export function computeOperatorInputCursorY(params: {
  terminalRows: number;
  hintLineCount: number;
  inputDisplayLineCount?: number;
  cursorLineOffset?: number;
}): number {
  const panesAboveInput =
    WORKER_PANE_HEIGHT +
    computeActivityPaneHeight(params) +
    OPEN_QUESTIONS_PANE_HEIGHT;

  const cursorLineOffset = params.cursorLineOffset ?? 0;
  const inputLineIndex =
    panesAboveInput + PANE_BORDER_ROWS / 2 + params.hintLineCount + cursorLineOffset;

  return inputLineIndex + OPERATOR_INPUT_CURSOR_Y_OFFSET;
}

/** 描画フレーム上のオペレータ入力行インデックス（`useCursor` の Y 補正前）。 */
export function computeOperatorInputLineIndex(params: {
  terminalRows: number;
  hintLineCount: number;
  inputDisplayLineCount?: number;
  cursorLineOffset?: number;
}): number {
  return computeOperatorInputCursorY(params) - OPERATOR_INPUT_CURSOR_Y_OFFSET;
}
