import type { OpenQuestion } from '@agents-ensemble/core';
import {
  parseInlineMarkdown,
  type InlineMarkdownLine,
  type InlineMarkdownSegment,
} from '../inline-markdown.js';
import {
  truncateInlineMarkdownLineToWidth,
  wrapInlineMarkdownToWidth,
} from './wrap-text-to-width.js';
import {
  OPEN_QUESTIONS_PANE_MAX_DISPLAY_LINES,
  OPEN_QUESTIONS_PANE_MAX_HEIGHT_RATIO,
  OPEN_QUESTIONS_PANE_MIN_HEIGHT,
  OPEN_QUESTIONS_PANE_TITLE,
  OPEN_QUESTIONS_SELECTION_HINT,
  PANE_BORDER_ROWS,
} from './tui-layout-constants.js';

export interface OpenQuestionListItemRender {
  id: string;
  lines: InlineMarkdownLine[];
  isSelected: boolean;
  compact: boolean;
}

export interface OpenQuestionsPaneLayout {
  paneHeight: number;
  titleText: string;
  titleSuffix?: string;
  contentLineCount: number;
  items: OpenQuestionListItemRender[];
  selectedIndex: number;
}

const OPEN_QUESTION_COMPACT_MAX_LINES = 2;

/** 端末行数から Open questions 本文の最大表示行数を算出する。 */
export function computeMaxOpenQuestionsDisplayLines(terminalRows: number): number {
  const ratioCap = Math.floor(terminalRows * OPEN_QUESTIONS_PANE_MAX_HEIGHT_RATIO);
  return Math.max(1, Math.min(OPEN_QUESTIONS_PANE_MAX_DISPLAY_LINES, ratioCap));
}

export function formatOpenQuestionsPaneTitle(
  selectedIndex: number,
  totalCount: number,
): { titleText: string; titleSuffix?: string } {
  if (totalCount === 0) {
    return { titleText: OPEN_QUESTIONS_PANE_TITLE };
  }

  const titleText = `${OPEN_QUESTIONS_PANE_TITLE} (${selectedIndex + 1}/${totalCount}${OPEN_QUESTIONS_SELECTION_HINT})`;
  return { titleText };
}

function buildSelectedQuestionItem(
  question: OpenQuestion,
  contentWidth: number,
): OpenQuestionListItemRender {
  return {
    id: question.id,
    lines: buildQuestionDetailLines(
      question,
      `▸ ${question.id} [${question.responseType}] `,
      contentWidth,
    ),
    isSelected: true,
    compact: false,
  };
}

function buildQuestionDetailLines(
  question: OpenQuestion,
  headerPrefix: string,
  contentWidth: number,
): InlineMarkdownLine[] {
  const lines = wrapInlineMarkdownToWidth(
    buildPrefixedSegments(headerPrefix, question.question),
    contentWidth,
  );
  if (question.context) {
    lines.push(
      ...wrapInlineMarkdownToWidth(
        buildPrefixedSegments('    ', question.context),
        contentWidth,
      ),
    );
  }
  if (question.choices) {
    for (const choice of question.choices) {
      lines.push(
        ...wrapInlineMarkdownToWidth(
          buildPrefixedSegments(`    ${choice.id}: `, choice.label),
          contentWidth,
        ),
      );
    }
  }
  return lines;
}

export function buildOpenQuestionListItems(
  openQuestions: OpenQuestion[],
  selectedIndex: number,
  contentWidth: number,
): OpenQuestionListItemRender[] {
  return openQuestions.map((question, index) => {
    if (index === selectedIndex) {
      return buildSelectedQuestionItem(question, contentWidth);
    }

    const lines = buildQuestionDetailLines(
      question,
      `  ${question.id} [${question.responseType}] `,
      contentWidth,
    );
    const compactLines = lines.slice(0, OPEN_QUESTION_COMPACT_MAX_LINES);
    if (lines.length > compactLines.length) {
      const lastIndex = compactLines.length - 1;
      const lastLine = compactLines[lastIndex];
      if (lastLine) {
        compactLines[lastIndex] = truncateInlineMarkdownLineToWidth(
          lastLine,
          contentWidth,
        );
      }
    }

    return {
      id: question.id,
      lines: compactLines,
      isSelected: false,
      compact: true,
    };
  });
}

function buildPrefixedSegments(
  prefix: string,
  text: string,
): InlineMarkdownSegment[] {
  return [{ text: prefix }, ...parseInlineMarkdown(text)];
}

export function countOpenQuestionsDisplayLines(items: OpenQuestionListItemRender[]): number {
  return items.reduce((sum, item) => sum + item.lines.length, 0);
}

/**
 * Fit selected detail into the content cap while reserving every compact row.
 *
 * Keep the original question order so the selected marker does not jump. When
 * the selected item is too long, only its detail is clipped; compact rows are
 * at most two lines each and remain in the render list.
 */
function fitOpenQuestionItemsToContentLimit(
  items: OpenQuestionListItemRender[],
  selectedIndex: number,
  maxContentLines: number,
  contentWidth: number,
): OpenQuestionListItemRender[] {
  const requestedContentLineCount = countOpenQuestionsDisplayLines(items);
  if (requestedContentLineCount <= maxContentLines) {
    return items;
  }

  const compactLineCount = items.reduce(
    (sum, item) => sum + (item.compact ? item.lines.length : 0),
    0,
  );
  const selectedItem = items[selectedIndex];
  if (!selectedItem || selectedItem.compact) {
    return items;
  }

  // Compact rows have priority. The selected item keeps at least its header
  // line; if the compact list itself exceeds the cap, the terminal's existing
  // short/overflow policy remains responsible for the final clipping.
  const selectedLineBudget = Math.max(1, maxContentLines - compactLineCount);
  if (selectedItem.lines.length <= selectedLineBudget) {
    return items;
  }

  return items.map((item, index) => {
    if (index !== selectedIndex) {
      return item;
    }
    const lines = item.lines.slice(0, selectedLineBudget);
    const lastIndex = lines.length - 1;
    const lastLine = lines[lastIndex];
    if (lastLine) {
      lines[lastIndex] = truncateInlineMarkdownLineToWidth(lastLine, contentWidth);
    }
    return { ...item, lines };
  });
}

export function resolveOpenQuestionsPaneLayout(params: {
  openQuestions: OpenQuestion[];
  selectedIndex: number;
  contentWidth: number;
  terminalRows: number;
}): OpenQuestionsPaneLayout {
  const totalCount = params.openQuestions.length;
  const selectedIndex = clampOpenQuestionSelectionIndex(params.selectedIndex, totalCount);
  const { titleText, titleSuffix } = formatOpenQuestionsPaneTitle(selectedIndex, totalCount);

  if (totalCount === 0) {
    return {
      paneHeight: 0,
      titleText,
      titleSuffix,
      contentLineCount: 0,
      items: [],
      selectedIndex: 0,
    };
  }

  const maxContentLines = computeMaxOpenQuestionsDisplayLines(params.terminalRows);
  const fullItems = buildOpenQuestionListItems(
    params.openQuestions,
    selectedIndex,
    params.contentWidth,
  );
  const items = fitOpenQuestionItemsToContentLimit(
    fullItems,
    selectedIndex,
    maxContentLines,
    params.contentWidth,
  );
  const contentLineCount = Math.max(1, countOpenQuestionsDisplayLines(items));

  const paneHeight = Math.max(
    OPEN_QUESTIONS_PANE_MIN_HEIGHT,
    PANE_BORDER_ROWS + contentLineCount,
  );

  return {
    paneHeight,
    titleText,
    titleSuffix,
    contentLineCount,
    items,
    selectedIndex,
  };
}

export function clampOpenQuestionSelectionIndex(
  selectedIndex: number,
  questionCount: number,
): number {
  if (questionCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(selectedIndex, questionCount - 1));
}

export function advanceOpenQuestionSelection(
  selectedIndex: number,
  direction: 'up' | 'down',
  questionCount: number,
): number {
  if (questionCount <= 0) {
    return 0;
  }
  if (direction === 'up') {
    return selectedIndex <= 0 ? questionCount - 1 : selectedIndex - 1;
  }
  return selectedIndex >= questionCount - 1 ? 0 : selectedIndex + 1;
}
