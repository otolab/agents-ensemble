/**
 * Ink `Box` の `height` は Yoga border-box（枠線を含む総行数）。
 * `borderStyle` 指定時は上下各 1 行が枠線として height 内に収まる。
 */

/** 枠線ありペインの上下枠線行数（`borderStyle` 指定時）。 */
export const PANE_BORDER_ROWS = 2;

/** Worker 状態ペインの固定高さ（枠線込み。`issue-session-tui` / `computeOperatorInputCursorY` で共有）。 */
export const WORKER_PANE_HEIGHT = 6;

/** Open questions ペインの固定高さ（枠線込み。同上）。 */
export const OPEN_QUESTIONS_PANE_HEIGHT = 4;

/** 入力ペインの枠線（上下）行数。`PANE_BORDER_ROWS` と同値。 */
export const INPUT_PANE_BORDER_ROWS = PANE_BORDER_ROWS;

/** round 枠線の表示幅（左右各 1 列）。 */
export const ROUND_BORDER_WIDTH = 2;

/** ペイン内水平 padding（`paddingX`）。 */
export const PANE_PADDING_X = 1;
