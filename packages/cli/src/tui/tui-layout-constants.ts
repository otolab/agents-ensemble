/**
 * Ink `Box` の `height` は Yoga border-box（枠線を含む総行数）。
 * `borderStyle` 指定時は上下各 1 行が枠線として height 内に収まる。
 */

/** 枠線ありペインの上下枠線行数（`borderStyle` 指定時）。 */
export const PANE_BORDER_ROWS = 2;

/** round 枠線の表示幅（左右各 1 列）。 */
export const ROUND_BORDER_WIDTH = 2;

/** メインペイン（Orchestration）の UI ラベル。conductor 対話とオーケストレーション状況の統合表示。 */
export const MAIN_PANE_TITLE = 'Orchestration';

/** Worker 状態ペインの固定高さ（枠線込み。タイトル + サマリ 3 行）。 */
export const WORKER_PANE_HEIGHT = 6;

/** Open questions ペインの固定高さ（枠線込み。タイトル + 1 行サマリ）。 */
export const OPEN_QUESTIONS_PANE_HEIGHT = 4;

/** 入力ペインの枠線（上下）行数。`PANE_BORDER_ROWS` と同値。 */
export const INPUT_PANE_BORDER_ROWS = PANE_BORDER_ROWS;

/** ペイン内水平 padding（`paddingX`）。 */
export const PANE_PADDING_X = 1;

/** 入力ペイン左枠線の列幅（`borderStyle="single"` の左 `│`）。 */
export const INPUT_PANE_LEFT_BORDER_COLUMNS = 1;

/**
 * 入力ペイン左端からテキストコンテンツ開始までの列数（左枠線 + `paddingX`）。
 * `useCursor` の X は Ink 出力原点からの絶対列であり、このオフセットを含める。
 */
export const INPUT_PANE_LEFT_COLUMNS = INPUT_PANE_LEFT_BORDER_COLUMNS + PANE_PADDING_X;

/**
 * Ink `useCursor` の Y 補正。`log-update` の `visibleLineCount` が描画行数より 1 大きい場合、
 * 実カーソルが入力行より 1 行上にずれる（オペレータ手動確認 iTerm2+tmux）。
 */
export const OPERATOR_INPUT_CURSOR_Y_OFFSET = 1;
