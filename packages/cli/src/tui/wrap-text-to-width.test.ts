import { describe, expect, it } from 'vitest';
import { parseInlineMarkdown } from '../inline-markdown.js';
import {
  getPaneContentWidth,
  wrapInlineMarkdownToWidth,
  wrapTextToWidth,
} from './wrap-text-to-width.js';

describe('wrapTextToWidth', () => {
  it('returns a single line when text fits', () => {
    expect(wrapTextToWidth('hello', 10)).toEqual(['hello']);
  });

  it('wraps at word boundaries', () => {
    expect(wrapTextToWidth('hello world foo', 8)).toEqual(['hello', 'world', 'foo']);
  });

  it('hard-breaks long tokens without spaces', () => {
    expect(wrapTextToWidth('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('preserves explicit newlines', () => {
    expect(wrapTextToWidth('line one\nline two', 20)).toEqual(['line one', 'line two']);
  });

  it('handles empty string', () => {
    expect(wrapTextToWidth('', 10)).toEqual(['']);
  });

  it('wraps CJK characters by display width', () => {
    expect(wrapTextToWidth('あいうえ', 4)).toEqual(['あい', 'うえ']);
  });
});

describe('getPaneContentWidth', () => {
  it('subtracts border and horizontal padding', () => {
    expect(
      getPaneContentWidth({
        columns: 80,
        paddingX: 1,
        borderWidth: 2,
      }),
    ).toBe(76);
  });
});

describe('wrapInlineMarkdownToWidth', () => {
  it('wraps across segment boundaries while preserving each style', () => {
    expect(
      wrapInlineMarkdownToWidth(parseInlineMarkdown('aa **bbcc** dd'), 5),
    ).toEqual([
      [{ text: 'aa' }],
      [{ text: 'bbcc', bold: true }],
      [{ text: 'dd' }],
    ]);
  });

  it('splits a styled segment without dropping its style', () => {
    expect(wrapInlineMarkdownToWidth([{ text: 'abcd', code: true }], 2)).toEqual([
      [{ text: 'ab', code: true }],
      [{ text: 'cd', code: true }],
    ]);
  });

  it('uses string-width for CJK text with style changes', () => {
    expect(
      wrapInlineMarkdownToWidth(parseInlineMarkdown('あい**うえ**'), 4),
    ).toEqual([
      [{ text: 'あい' }],
      [{ text: 'うえ', bold: true }],
    ]);
  });

  it('preserves explicit newlines between styled lines', () => {
    expect(
      wrapInlineMarkdownToWidth(parseInlineMarkdown('**first**\n`second`'), 20),
    ).toEqual([
      [{ text: 'first', bold: true }],
      [{ text: 'second', code: true }],
    ]);
  });
});
