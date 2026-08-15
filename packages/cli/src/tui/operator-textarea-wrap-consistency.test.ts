import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { buildVisualRows } from 'react-ink-textarea/dist/textUtils.js';
import { computeOperatorInputLayout } from './operator-input-layout.js';

/** `OperatorTextArea` の linePrefix 付き折り返し幅（1 行目先頭チャンクのみプロンプト分を差し引く）。 */
function resolveOperatorTextAreaLineWidth(
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
function computeTextAreaVisualLineTexts(
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
function operatorInputLayoutsMatch(
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

describe('operator-textarea wrap consistency', () => {
  it('matches operator-input-layout for CJK text without spaces', () => {
    const value = '日本語入力のテストです。長めの文を折り返します。';
    const contentWidth = 20;
    const promptPrefix = 'operator> ';

    expect(operatorInputLayoutsMatch(value, contentWidth, promptPrefix)).toBe(true);
  });

  it('matches for explicit newlines with operator prompt width', () => {
    const value = '1行目\n2行目\n3行目';
    const contentWidth = 30;
    const promptPrefix = 'operator> ';

    expect(operatorInputLayoutsMatch(value, contentWidth, promptPrefix)).toBe(true);
  });

  it('matches for long multiline input used in scroll tests', () => {
    const value = 'line\n'.repeat(8).trimEnd();
    const contentWidth = 10;

    expect(operatorInputLayoutsMatch(value, contentWidth)).toBe(true);
  });

  it('documents divergence for ASCII with word-boundary wrapping', () => {
    const value = 'hello world wrap test';
    const contentWidth = 10;
    const promptWidth = stringWidth('operator> ');

    const layoutLines = computeOperatorInputLayout(value, contentWidth, promptWidth).displayLines;
    const visualLines = computeTextAreaVisualLineTexts(value, contentWidth, promptWidth);

    expect(layoutLines).not.toEqual(visualLines);
  });
});
