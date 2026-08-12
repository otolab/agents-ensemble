import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '@agents-ensemble/core';
import {
  advanceOpenQuestionsScrollOffset,
  buildOpenQuestionDisplayLines,
  computeOpenQuestionsContentLineCount,
  resolveOpenQuestionsScrollLayout,
  sliceOpenQuestionDisplayLines,
} from './open-questions-pane.js';
import { OPEN_QUESTIONS_PANE_HEIGHT } from './tui-layout-constants.js';

const SAMPLE_QUESTION: OpenQuestion = {
  id: 'inq-1',
  question: 'Approve?',
  responseType: 'text',
  source: 'conductor',
  status: 'open',
  askedAt: 1,
};

describe('buildOpenQuestionDisplayLines', () => {
  it('expands question and context with wrapping', () => {
    const lines = buildOpenQuestionDisplayLines(
      [
        {
          ...SAMPLE_QUESTION,
          question: 'alpha beta gamma delta',
          context: 'extra context here',
        },
      ],
      10,
    );

    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toContain('inq-1');
    expect(lines.some((line) => line.startsWith('  '))).toBe(true);
  });
});

describe('sliceOpenQuestionDisplayLines', () => {
  it('shows from top by default and scrolls down with linesFromTop', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    expect(sliceOpenQuestionDisplayLines(lines, 2, 0)).toEqual(['a', 'b']);
    expect(sliceOpenQuestionDisplayLines(lines, 2, 2)).toEqual(['c', 'd']);
    expect(sliceOpenQuestionDisplayLines(lines, 2, 10)).toEqual(['d', 'e']);
  });
});

describe('advanceOpenQuestionsScrollOffset', () => {
  it('moves from top toward bottom and back', () => {
    expect(advanceOpenQuestionsScrollOffset(0, 'pageDown', 2, 6)).toBe(2);
    expect(advanceOpenQuestionsScrollOffset(4, 'pageUp', 2, 6)).toBe(2);
    expect(advanceOpenQuestionsScrollOffset(3, 'home', 2, 6)).toBe(0);
    expect(advanceOpenQuestionsScrollOffset(1, 'end', 2, 6)).toBe(6);
  });
});

describe('computeOpenQuestionsContentLineCount', () => {
  it('reserves border and title rows inside the pane height', () => {
    expect(computeOpenQuestionsContentLineCount(4, 1)).toBe(1);
    expect(computeOpenQuestionsContentLineCount(6, 1)).toBe(3);
  });
});

describe('resolveOpenQuestionsScrollLayout', () => {
  it('shows scroll hint from the first frame when content overflows', () => {
    const layout = resolveOpenQuestionsScrollLayout({
      displayLineCount: 5,
      paneHeight: OPEN_QUESTIONS_PANE_HEIGHT,
      contentWidth: 80,
    });

    expect(layout.isScrollable).toBe(true);
    expect(layout.scrollHint).toContain('Alt+PgUp/PgDn');
  });

  it('omits scroll hint when all lines fit', () => {
    const layout = resolveOpenQuestionsScrollLayout({
      displayLineCount: 1,
      paneHeight: OPEN_QUESTIONS_PANE_HEIGHT,
      contentWidth: 80,
    });

    expect(layout.isScrollable).toBe(false);
    expect(layout.scrollHint).toBe('');
  });
});
