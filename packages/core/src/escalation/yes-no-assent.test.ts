import { describe, expect, it } from 'vitest';
import { parseChoiceSelection, parseYesNoAssent } from './yes-no-assent.js';

describe('parseYesNoAssent', () => {
  it.each([
    ['y', 'yes'],
    ['Yes', 'yes'],
    ['OK.', 'yes'],
    ['okです。', 'yes'],
    ['はい', 'yes'],
    ['了解しました', 'yes'],
    ['n', 'no'],
    ['Nope', 'no'],
    ['no thanks', 'no'],
    ['いいえ', 'no'],
    ['許可しません', 'no'],
    ['maybe', 'unclear'],
    ['I will think about it', 'unclear'],
    ['どちらとも言えません', 'unclear'],
  ] as const)('parses %j as %s', (answer, expected) => {
    expect(parseYesNoAssent(answer)).toBe(expected);
  });
});

describe('parseChoiceSelection', () => {
  const choices = [
    { id: 'A', label: 'Ship now' },
    { id: 'B', label: 'Wait for review' },
    { id: 'C', label: 'Cancel' },
  ];

  it.each([
    ['B', 'B'],
    ['2', 'B'],
    ['wait for review', 'B'],
    ['Wait for review.', 'B'],
    ['unknown', undefined],
  ])('resolves %j to %s', (answer, expected) => {
    expect(parseChoiceSelection(answer, choices)).toBe(expected);
  });

  it('does not guess when multiple options share a label', () => {
    expect(
      parseChoiceSelection('Keep', [
        { id: 'A', label: 'Keep' },
        { id: 'B', label: 'Keep' },
      ]),
    ).toBeUndefined();
  });

  it('does not guess when normalized option ids are ambiguous', () => {
    expect(
      parseChoiceSelection('A', [
        { id: 'A', label: 'Ship now' },
        { id: 'a.', label: 'Ship later' },
      ]),
    ).toBeUndefined();
  });
});
