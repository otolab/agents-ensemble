/**
 * Ink `Box` の `height` は Yoga border-box（枠線を含む総行数）。
 * `borderStyle` 指定時は上下各 1 行が枠線として height 内に収まる。
 */

/** 枠線ありペインの上下枠線行数（`borderStyle` 指定時）。 */
export const PANE_BORDER_ROWS = 2;

/** round / single 枠線の左（または右）列幅。 */
export const SINGLE_BORDER_WIDTH = 1;

/** round 枠線の表示幅（左右各 1 列）。 */
export const ROUND_BORDER_WIDTH = 2;

/** Worker 状態ペインの固定高さ（枠線込み。タイトル + worker 3 行分）。 */
export const WORKER_PANE_HEIGHT = 7;

/** Open questions ペインの固定高さ（枠線込み。同上）。 */
export const OPEN_QUESTIONS_PANE_HEIGHT = 4;

/** 入力ペインの枠線（上下）行数。`PANE_BORDER_ROWS` と同値。 */
export const INPUT_PANE_BORDER_ROWS = PANE_BORDER_ROWS;

/** ペイン内水平 padding（`paddingX`）。 */
export const PANE_PADDING_X = 1;

/** 入力ペイン左枠線の列幅（`borderStyle="single"` の左 `│`）。 */
export const INPUT_PANE_LEFT_BORDER_COLUMNS = SINGLE_BORDER_WIDTH;

/**
 * 入力ペイン左端からテキストコンテンツ開始までの列数（左枠線 + `paddingX`）。
 * `useCursor` の X は Ink 出力原点からの絶対列であり、このオフセットを含める。
 */
export const INPUT_PANE_LEFT_COLUMNS = INPUT_PANE_LEFT_BORDER_COLUMNS + PANE_PADDING_X;
