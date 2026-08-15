import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  computeTextAreaVisualLineTexts,
  operatorInputLayoutsMatch,
} from './operator-textarea-wrap-consistency.js';
import { computeOperatorInputLayout } from './operator-input-layout.js';

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
