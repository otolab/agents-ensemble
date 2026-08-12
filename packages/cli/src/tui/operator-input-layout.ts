import stringWidth from 'string-width';
import { findWrapBreakIndex } from './wrap-text-to-width.js';
import {
  INPUT_PANE_MAX_DISPLAY_LINES,
  INPUT_PANE_MAX_HEIGHT_RATIO,
  INPUT_PANE_MIN_DISPLAY_LINES,
} from './tui-layout-constants.js';

export interface OperatorInputDisplayPosition {
  readonly displayLineIndex: number;
  readonly columnInLine: number;
}

export interface OperatorInputLayout {
  readonly displayLines: string[];
  readonly lineStartOffsets: number[];
}

/** 先頭・末尾の空白行のみ除去。行内空白と本文中の改行は保持する。 */
export function trimBlankLinesOnly(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') {
    start++;
  }
  while (end > start && lines[end - 1]?.trim() === '') {
    end--;
  }
  return lines.slice(start, end).join('\n');
}

/** 端末行数から入力欄の最大表示行数を算出する。 */
export function computeMaxInputDisplayLines(terminalRows: number): number {
  const ratioCap = Math.floor(terminalRows * INPUT_PANE_MAX_HEIGHT_RATIO);
  return Math.max(
    INPUT_PANE_MIN_DISPLAY_LINES,
    Math.min(INPUT_PANE_MAX_DISPLAY_LINES, ratioCap),
  );
}

/** 表示行と各行の value 内開始 offset を同時に算出する。 */
export function computeOperatorInputLayout(
  value: string,
  contentWidth: number,
  promptWidth: number,
): OperatorInputLayout {
  const displayLines: string[] = [];
  const lineStartOffsets: number[] = [];
  const firstLineWidth = Math.max(1, contentWidth - promptWidth);
  const paragraphs = value.split('\n');
  let absoluteOffset = 0;

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex] ?? '';
    const paragraphStart = absoluteOffset;
    let remaining = paragraph;

    if (remaining.length === 0) {
      lineStartOffsets.push(paragraphStart);
      displayLines.push('');
    } else {
      while (remaining.length > 0) {
        const availableWidth = displayLines.length === 0 ? firstLineWidth : contentWidth;
        const lineStartInParagraph = paragraph.length - remaining.length;
        if (stringWidth(remaining) <= availableWidth) {
          lineStartOffsets.push(paragraphStart + lineStartInParagraph);
          displayLines.push(remaining);
          remaining = '';
        } else {
          const breakAt = findWrapBreakIndex(remaining, availableWidth);
          lineStartOffsets.push(paragraphStart + lineStartInParagraph);
          displayLines.push(remaining.slice(0, breakAt));
          remaining = remaining.slice(breakAt).trimStart();
        }
      }
    }

    absoluteOffset = paragraphStart + paragraph.length + 1;
  }

  if (displayLines.length === 0) {
    displayLines.push('');
    lineStartOffsets.push(0);
  }

  return { displayLines, lineStartOffsets };
}

/**
 * オペレータ入力の表示行を算出する。
 * 1 行目はプロンプト幅分だけ狭く折り返し、2 行目以降はペイン全幅を使う。
 */
export function computeOperatorInputDisplayLines(
  value: string,
  contentWidth: number,
  promptWidth: number,
): string[] {
  return computeOperatorInputLayout(value, contentWidth, promptWidth).displayLines;
}

/** 入力文字列内のカーソル offset を表示行・列に変換する。 */
export function mapCursorOffsetToDisplayPosition(
  value: string,
  cursorOffset: number,
  contentWidth: number,
  promptWidth: number,
): OperatorInputDisplayPosition {
  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  const { displayLines, lineStartOffsets } = computeOperatorInputLayout(
    value,
    contentWidth,
    promptWidth,
  );

  let displayLineIndex = 0;
  for (let index = lineStartOffsets.length - 1; index >= 0; index--) {
    const lineStart = lineStartOffsets[index] ?? 0;
    if (clampedOffset >= lineStart) {
      displayLineIndex = index;
      break;
    }
  }

  const lineStart = lineStartOffsets[displayLineIndex] ?? 0;
  const textBeforeCursor = value.slice(lineStart, clampedOffset);
  const lineText = displayLines[displayLineIndex] ?? '';
  return {
    displayLineIndex,
    columnInLine: Math.min(stringWidth(textBeforeCursor), stringWidth(lineText)),
  };
}

/** 表示行インデックスと列から value 内のカーソル offset を逆算する。 */
export function mapDisplayPositionToCursorOffset(
  value: string,
  displayLineIndex: number,
  columnInLine: number,
  contentWidth: number,
  promptWidth: number,
): number {
  const { displayLines, lineStartOffsets } = computeOperatorInputLayout(
    value,
    contentWidth,
    promptWidth,
  );
  const clampedLineIndex = Math.max(0, Math.min(displayLineIndex, displayLines.length - 1));
  const lineText = displayLines[clampedLineIndex] ?? '';
  const targetColumn = Math.min(Math.max(0, columnInLine), stringWidth(lineText));
  const lineStart = lineStartOffsets[clampedLineIndex] ?? 0;

  let width = 0;
  for (let index = 1; index <= lineText.length; index++) {
    const nextWidth = stringWidth(lineText.slice(0, index));
    if (nextWidth >= targetColumn) {
      return lineStart + index - (nextWidth > targetColumn ? 1 : 0);
    }
    width = nextWidth;
  }

  return lineStart + lineText.length;
}

/** 末尾追従用に表示する行スライスを返す。 */
export function sliceVisibleInputDisplayLines(
  displayLines: string[],
  maxVisibleLines: number,
): { visibleLines: string[]; scrollOffset: number } {
  if (displayLines.length <= maxVisibleLines) {
    return { visibleLines: displayLines, scrollOffset: 0 };
  }
  const scrollOffset = displayLines.length - maxVisibleLines;
  return {
    visibleLines: displayLines.slice(scrollOffset),
    scrollOffset,
  };
}
