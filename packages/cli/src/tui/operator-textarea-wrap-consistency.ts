import stringWidth from 'string-width';
import { buildVisualRows } from 'react-ink-textarea/dist/textUtils.js';
import { computeOperatorInputLayout } from './operator-input-layout.js';

/** `OperatorTextArea` の linePrefix 付き折り返し幅（1 行目先頭チャンクのみプロンプト分を差し引く）。 */
export function resolveOperatorTextAreaLineWidth(
  contentWidth: number,
  promptWidth: number,
  lineIdx: number,
  chunkIdx: number,
): number {
  return lineIdx === 0 && chunkIdx === 0
    ? Math.max(1, contentWidth - promptWidth)
    : contentWidth;
}

/** `react-ink-textarea` の visual row テキスト列（仮想行を除く）。 */
export function computeTextAreaVisualLineTexts(
  value: string,
  contentWidth: number,
  promptWidth: number,
): string[] {
  const lineWidthAt = (lineIdx: number, chunkIdx: number) =>
    resolveOperatorTextAreaLineWidth(contentWidth, promptWidth, lineIdx, chunkIdx);

  const rows = buildVisualRows(value.split('\n'), lineWidthAt, 0, 0, 1);
  return rows.filter((row) => !row.isVirtualLine).map((row) => row.text);
}

/** IME 用 layout と TextArea 表示の折り返し行が一致するか。 */
export function operatorInputLayoutsMatch(
  value: string,
  contentWidth: number,
  promptPrefix = '',
): boolean {
  const promptWidth = stringWidth(promptPrefix);
  const layoutLines = computeOperatorInputLayout(value, contentWidth, promptWidth).displayLines;
  const visualLines = computeTextAreaVisualLineTexts(value, contentWidth, promptWidth);

  if (layoutLines.length !== visualLines.length) {
    return false;
  }

  return layoutLines.every((line, index) => line === visualLines[index]);
}
