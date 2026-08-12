import { describe, expect, it } from 'vitest';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';

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
