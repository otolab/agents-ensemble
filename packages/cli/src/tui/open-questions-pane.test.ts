import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '@agents-ensemble/core';
import {
  advanceOpenQuestionSelection,
  buildOpenQuestionListItems,
  clampOpenQuestionSelectionIndex,
  computeMaxOpenQuestionsDisplayLines,
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
    expect(
      items[1]?.lines.some((line) =>
        line.some((segment) => segment.text.includes('more detail')),
      ),
    ).toBe(true);
  });

  it('renders Markdown styles in the selected question and context', () => {
    const [item] = buildOpenQuestionListItems(
      [
        createQuestion({
          id: 'inq-1',
          question: 'Run **this** with `command`?',
          context: 'Use **care**.',
        }),
      ],
      0,
      80,
    );

    expect(item?.lines).toEqual([
      [
        { text: '▸ inq-1 [text] Run ' },
        { text: 'this', bold: true },
        { text: ' with ' },
        { text: 'command', code: true },
        { text: '?' },
      ],
      [{ text: '    Use ' }, { text: 'care', bold: true }, { text: '.' }],
    ]);
  });

  it('renders nested list and table Markdown in question and context', () => {
    const [item] = buildOpenQuestionListItems(
      [
        createQuestion({
          id: 'inq-nested-markdown',
          question:
            '- **choose** [this](https://example.com/question)\n' +
            '  - **`deep`**',
          context:
            '| **Field** | Value |\n| --- | --- |\n| `mode` | [safe](https://example.com/context) |',
        }),
      ],
      0,
      120,
    );
    const segments = item?.lines.flat() ?? [];

    expect(segments).toEqual(
      expect.arrayContaining([
        { text: 'choose', bold: true },
        { text: 'this', href: 'https://example.com/question' },
        { text: 'deep', bold: true, code: true },
        { text: 'Field', bold: true },
        { text: 'mode', code: true },
        { text: 'safe', href: 'https://example.com/context' },
      ]),
    );
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

describe('resolveOpenQuestionsPaneLayout', () => {
  it('raises the normal-terminal content cap for expanded question details', () => {
    expect(computeMaxOpenQuestionsDisplayLines(23)).toBe(13);
    expect(computeMaxOpenQuestionsDisplayLines(24)).toBe(14);
  });

  it('uses zero height when there are no open questions', () => {
    const layout = resolveOpenQuestionsPaneLayout({
      openQuestions: [],
      selectedIndex: 0,
      contentWidth: 80,
      terminalRows: 24,
    });

    expect(layout.paneHeight).toBe(0);
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
    expect(layout.titleText).toContain('Shift+↑↓で選択');
  });

  it('keeps compact entries when selected detail reaches the content cap', () => {
    const layout = resolveOpenQuestionsPaneLayout({
      openQuestions: [
        {
          ...SAMPLE_QUESTION,
          question: 'selected '.repeat(80),
          context: 'context '.repeat(60),
        },
        createQuestion({ id: 'inq-2', question: 'Second question' }),
      ],
      selectedIndex: 0,
      contentWidth: 40,
      terminalRows: 23,
    });

    expect(layout.items).toHaveLength(2);
    expect(layout.items[0]?.isSelected).toBe(true);
    expect(layout.items[1]?.compact).toBe(true);
    expect(layout.titleText).toContain('1/2');
    expect(layout.contentLineCount).toBe(13);
    expect(layout.contentLineCount).toBe(
      layout.items.reduce((sum, item) => sum + item.lines.length, 0),
    );
    expect(layout.items[0]?.lines).toHaveLength(12);
  });

  it('counts each non-selected question as one compact line in the requested height', () => {
    const layout = resolveOpenQuestionsPaneLayout({
      openQuestions: [
        {
          ...SAMPLE_QUESTION,
          question: 'selected '.repeat(20),
          context: 'context '.repeat(10),
        },
        createQuestion({ id: 'inq-2', question: 'Second question' }),
        createQuestion({ id: 'inq-3', question: 'Third question' }),
      ],
      selectedIndex: 0,
      contentWidth: 40,
      terminalRows: 23,
    });

    expect(layout.items).toHaveLength(3);
    expect(layout.items.slice(1).every((item) => item.compact)).toBe(true);
    expect(layout.contentLineCount).toBe(
      layout.items.reduce((sum, item) => sum + item.lines.length, 0),
    );
  });

  it('does not append the discretionary input hint to the title', () => {
    const layout = resolveOpenQuestionsPaneLayout({
      openQuestions: [SAMPLE_QUESTION],
      selectedIndex: 0,
      contentWidth: 80,
      terminalRows: 24,
    });

    expect(layout.titleSuffix).toBeUndefined();
  });
});
