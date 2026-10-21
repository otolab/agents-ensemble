import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '@agents-ensemble/core';
import {
  advanceOpenQuestionSelection,
  advanceOpenQuestionsScrollOffset,
  buildOpenQuestionListItems,
  clampOpenQuestionSelectionIndex,
  computeMaxOpenQuestionsDisplayLines,
  resolveOpenQuestionsPaneViewport,
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

  it('shows the linked permission id and operation summary in question context', () => {
    const summary =
      'permission.pending worker=implementer tool=Edit path=src/example.ts id=perm-123...';
    const [item] = buildOpenQuestionListItems(
      [
        createQuestion({
          id: 'inq-permission',
          question: 'Should I allow this edit?',
          context: summary,
          relatedPermissionId: 'permission-request-123456',
        }),
      ],
      0,
      120,
    );

    const rendered = item?.lines.flat().map((segment) => segment.text).join('');
    expect(rendered).toContain('inq-permission');
    expect(rendered).toContain(summary);
    expect(rendered).toContain('id=perm-123...');
  });

  it('shows choice ids and labels for the selected question', () => {
    const [item] = buildOpenQuestionListItems(
      [
        createQuestion({
          id: 'inq-choice',
          question: 'Which approach?',
          responseType: 'choice',
          choices: [
            { id: 'A', label: 'Ship now' },
            { id: 'B', label: 'Wait for review' },
          ],
        }),
      ],
      0,
      80,
    );

    const rendered = item?.lines.flat().map((segment) => segment.text).join('');
    expect(rendered?.replace(/\s+/gu, ' ')).toContain('A: Ship now');
    expect(rendered?.replace(/\s+/gu, ' ')).toContain('B: Wait for review');
  });

  it('preserves selected question, context, and choice line breaks', () => {
    const [item] = buildOpenQuestionListItems(
      [
        createQuestion({
          id: 'inq-multiline',
          question: 'Question line one\nQuestion line two',
          context: 'Context line one\nContext line two',
          responseType: 'choice',
          choices: [{ id: 'A', label: 'Choice line one\nChoice line two' }],
        }),
      ],
      0,
      80,
    );

    expect(item?.lines.map((line) => line.map((segment) => segment.text).join(''))).toEqual([
      '▸ inq-multiline [choice] Question line one',
      'Question line two',
      '    Context line one',
      'Context line two',
      '    A: Choice line one',
      'Choice line two',
    ]);
  });

  it('shows up to two compact lines and marks omitted question, context, or choice text', () => {
    const items = buildOpenQuestionListItems(
      [
        createQuestion({ id: 'inq-selected', question: 'Selected?' }),
        createQuestion({
          id: 'inq-question',
          question: 'Question line one\nQuestion line two\nQuestion line three',
        }),
        createQuestion({
          id: 'inq-choice',
          question: 'Choice?',
          responseType: 'choice',
          choices: [{ id: 'A', label: 'Choice line one\nChoice line two' }],
        }),
        createQuestion({
          id: 'inq-context',
          question: 'Context?',
          context: 'Context line one\nContext line two',
        }),
      ],
      0,
      80,
    );

    expect(items.slice(1).map((item) => item.lines.map((line) =>
      line.map((segment) => segment.text).join(''),
    ))).toEqual([
      [
        '  inq-question [text] Question line one',
        'Question line two…',
      ],
      [
        '  inq-choice [choice] Choice?',
        '    A: Choice line one…',
      ],
      [
        '  inq-context [text] Context?',
        '    Context line one…',
      ],
    ]);
    expect(items.slice(1).every((item) => item.lines.length <= 2)).toBe(true);
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

describe('Open questions pane viewport', () => {
  it('windows the selected full detail and clamps its offset at both ends', () => {
    const items = buildOpenQuestionListItems(
      [
        createQuestion({
          id: 'inq-long',
          question: 'Question?',
          context: Array.from({ length: 8 }, (_, index) => `context-row-${index}`).join('\n'),
        }),
      ],
      0,
      80,
    );

    const top = resolveOpenQuestionsPaneViewport({
      items,
      selectedIndex: 0,
      visibleLineCount: 3,
      linesFromTop: 0,
    });
    expect(items[0]?.lines).toHaveLength(9);
    expect(top.visibleItems[0]?.lines.map((line) => line.map((segment) => segment.text).join('')))
      .toEqual([
        '▸ inq-long [text] Question?',
        '    context-row-0',
        'context-row-1',
      ]);
    expect(top.linesFromTop).toBe(0);
    expect(top.canScrollUp).toBe(false);
    expect(top.canScrollDown).toBe(true);

    const bottom = resolveOpenQuestionsPaneViewport({
      items,
      selectedIndex: 0,
      visibleLineCount: 3,
      linesFromTop: 100,
    });
    expect(bottom.visibleItems[0]?.lines.map((line) => line.map((segment) => segment.text).join('')))
      .toEqual([
        'context-row-5',
        'context-row-6',
        'context-row-7',
      ]);
    expect(bottom.linesFromTop).toBe(6);
    expect(bottom.canScrollUp).toBe(true);
    expect(bottom.canScrollDown).toBe(false);
    expect(advanceOpenQuestionsScrollOffset(0, 'up', 6)).toBe(0);
    expect(advanceOpenQuestionsScrollOffset(0, 'down', 6)).toBe(1);
    expect(advanceOpenQuestionsScrollOffset(100, 'down', 6)).toBe(6);
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
    expect(layout.contentLineCount).toBeLessThan(
      layout.items.reduce((sum, item) => sum + item.lines.length, 0),
    );
    expect(layout.items[0]?.lines.length).toBeGreaterThan(12);
    expect(
      layout.items[0]?.lines.at(-1)?.map((segment) => segment.text).join(''),
    ).toContain('context');
  });

  it('reserves each non-selected question compact line in the requested height', () => {
    const layout = resolveOpenQuestionsPaneLayout({
      openQuestions: [
        {
          ...SAMPLE_QUESTION,
          question: 'selected '.repeat(20),
          context: 'context '.repeat(10),
        },
        createQuestion({ id: 'inq-2', question: 'Second question' }),
        createQuestion({ id: 'inq-3', question: 'Third question\nMore detail' }),
      ],
      selectedIndex: 0,
      contentWidth: 40,
      terminalRows: 23,
    });

    expect(layout.items).toHaveLength(3);
    expect(layout.items.slice(1).every((item) => item.compact)).toBe(true);
    expect(layout.items[2]?.lines).toHaveLength(2);
    const viewport = resolveOpenQuestionsPaneViewport({
      items: layout.items,
      selectedIndex: layout.selectedIndex,
      visibleLineCount: layout.contentLineCount,
      linesFromTop: 0,
    });
    expect(viewport.contentLineCount).toBe(layout.contentLineCount);
    expect(viewport.visibleItems.slice(1).every((item) => item.compact)).toBe(true);
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
