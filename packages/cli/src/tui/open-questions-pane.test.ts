import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '@agents-ensemble/core';
import {
  advanceOpenQuestionSelection,
  buildOpenQuestionListItems,
  clampOpenQuestionSelectionIndex,
  formatSelectedOpenQuestionAnswer,
  resolveOpenQuestionsPaneLayout,
} from './open-questions-pane.js';
import { OPEN_QUESTIONS_PANE_MIN_HEIGHT } from './tui-layout-constants.js';

const SAMPLE_QUESTION: OpenQuestion = {
  id: 'inq-1',
  question: 'Approve?',
  responseType: 'text',
  source: 'conductor',
  status: 'open',
  askedAt: 1,
};

function createQuestion(
  overrides: Partial<OpenQuestion> & Pick<OpenQuestion, 'id' | 'question'>,
): OpenQuestion {
  return {
    responseType: 'text',
    source: 'conductor',
    status: 'open',
    askedAt: 1,
    ...overrides,
  };
}

describe('buildOpenQuestionListItems', () => {
  it('expands the selected question and compacts others', () => {
    const items = buildOpenQuestionListItems(
      [
        createQuestion({ id: 'inq-1', question: 'First' }),
        createQuestion({ id: 'inq-2', question: 'Second', context: 'more detail' }),
      ],
      1,
      80,
    );

    expect(items[0]?.compact).toBe(true);
    expect(items[1]?.isSelected).toBe(true);
    expect(items[1]?.lines.some((line) => line.includes('more detail'))).toBe(true);
  });
});

describe('advanceOpenQuestionSelection', () => {
  it('wraps at both ends', () => {
    expect(advanceOpenQuestionSelection(0, 'up', 3)).toBe(2);
    expect(advanceOpenQuestionSelection(2, 'down', 3)).toBe(0);
  });
});

describe('clampOpenQuestionSelectionIndex', () => {
  it('clamps to available questions', () => {
    expect(clampOpenQuestionSelectionIndex(5, 2)).toBe(1);
    expect(clampOpenQuestionSelectionIndex(0, 0)).toBe(0);
  });
});

describe('formatSelectedOpenQuestionAnswer', () => {
  it('prefixes @inq for the selected question', () => {
    expect(formatSelectedOpenQuestionAnswer('yes', 'inq-2')).toBe('@inq:inq-2 yes');
  });
});

describe('resolveOpenQuestionsPaneLayout', () => {
  it('uses minimum height when there are no open questions', () => {
    const layout = resolveOpenQuestionsPaneLayout({
      openQuestions: [],
      selectedIndex: 0,
      contentWidth: 80,
      terminalRows: 24,
    });

    expect(layout.paneHeight).toBe(OPEN_QUESTIONS_PANE_MIN_HEIGHT);
    expect(layout.titleText).toBe('Open questions');
  });

  it('grows with selected question detail and shows selection hint', () => {
    const layout = resolveOpenQuestionsPaneLayout({
      openQuestions: [
        {
          ...SAMPLE_QUESTION,
          question: 'word '.repeat(30),
          context: 'context '.repeat(10),
        },
      ],
      selectedIndex: 0,
      contentWidth: 40,
      terminalRows: 24,
    });

    expect(layout.paneHeight).toBeGreaterThan(OPEN_QUESTIONS_PANE_MIN_HEIGHT);
    expect(layout.titleText).toContain('1/1');
    expect(layout.titleText).toContain('↑↓で選択');
  });
});
