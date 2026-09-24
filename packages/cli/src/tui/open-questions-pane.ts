import type { OpenQuestion } from '@agents-ensemble/core';
import {
  parseInlineMarkdown,
  type InlineMarkdownLine,
  type InlineMarkdownSegment,
} from '../inline-markdown.js';
import { wrapInlineMarkdownToWidth } from './wrap-text-to-width.js';
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
  const headerSegments = buildPrefixedSegments(
    `▸ ${question.id} [${question.responseType}] `,
    question.question,
  );
  const lines = wrapInlineMarkdownToWidth(headerSegments, contentWidth);
  if (question.context) {
    lines.push(
      ...wrapInlineMarkdownToWidth(
        buildPrefixedSegments('    ', question.context),
        contentWidth,
      ),
    );
  }
  return {
    id: question.id,
    lines,
    isSelected: true,
    compact: false,
  };
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

    const headerSegments = buildPrefixedSegments(
      `  ${question.id} [${question.responseType}] `,
      question.question,
    );
    return {
      id: question.id,
      lines: [wrapInlineMarkdownToWidth(headerSegments, contentWidth)[0] ?? []],
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
 * one line each and remain in the render list.
 */
function fitOpenQuestionItemsToContentLimit(
  items: OpenQuestionListItemRender[],
  selectedIndex: number,
  maxContentLines: number,
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

  return items.map((item, index) =>
    index === selectedIndex
      ? { ...item, lines: item.lines.slice(0, selectedLineBudget) }
      : item,
  );
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
