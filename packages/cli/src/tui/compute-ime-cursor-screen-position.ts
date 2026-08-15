export interface ImeCursorScreenPositionInput {
  readonly focus: boolean;
  readonly cursorStart?: { readonly x?: number; readonly y: number };
  readonly promptWidth: number;
  readonly scrollOffset: number;
  readonly visibleCursorLineIndex: number;
  readonly cursorColumnInVisibleLine: number;
}

/** Ink `useCursor` へ渡す IME 物理カーソル座標を算出する。 */
export function computeImeCursorScreenPosition(
  input: ImeCursorScreenPositionInput,
): { readonly x: number; readonly y: number } | undefined {
  const {
    focus,
    cursorStart,
    promptWidth,
    scrollOffset,
    visibleCursorLineIndex,
    cursorColumnInVisibleLine,
  } = input;

  if (!focus || cursorStart === undefined || visibleCursorLineIndex < 0) {
    return undefined;
  }

  const contentStartX = (cursorStart.x ?? 0) - promptWidth;
  const lineStartX =
    visibleCursorLineIndex === 0 && scrollOffset === 0 ? (cursorStart.x ?? 0) : contentStartX;

  return {
    x: lineStartX + cursorColumnInVisibleLine,
    y: cursorStart.y + visibleCursorLineIndex,
  };
}
