import type { OpenQuestion } from '@agents-ensemble/core';
import { wrapTextToWidth } from './wrap-text-to-width.js';
import {
  OPEN_QUESTIONS_PANE_MAX_DISPLAY_LINES,
  OPEN_QUESTIONS_PANE_MAX_HEIGHT_RATIO,
  OPEN_QUESTIONS_PANE_MIN_HEIGHT,
  OPEN_QUESTIONS_SELECTION_HINT,
  PANE_BORDER_ROWS,
} from './tui-layout-constants.js';

export interface OpenQuestionListItemRender {
  id: string;
  lines: string[];
  isSelected: boolean;
  compact: boolean;
}

export interface OpenQuestionsPaneLayout {
  paneHeight: number;
  titleLineCount: number;
  titleText: string;
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
  contentWidth: number,
): { titleText: string; titleLineCount: number } {
  if (totalCount === 0) {
    return { titleText: 'Open questions', titleLineCount: 1 };
  }

  const titleText = `Open questions (${selectedIndex + 1}/${totalCount}${OPEN_QUESTIONS_SELECTION_HINT})`;
  return {
    titleText,
    titleLineCount: wrapTextToWidth(titleText, contentWidth).length,
  };
}

function buildSelectedQuestionItem(
  question: OpenQuestion,
  contentWidth: number,
): OpenQuestionListItemRender {
  const header = `▸ ${question.id} [${question.responseType}] ${question.question}`;
  const lines = [...wrapTextToWidth(header, contentWidth)];
  if (question.context) {
    lines.push(...wrapTextToWidth(`    ${question.context}`, contentWidth));
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

    const header = `  ${question.id} [${question.responseType}] ${question.question}`;
    return {
      id: question.id,
      lines: [wrapTextToWidth(header, contentWidth)[0] ?? header],
      isSelected: false,
      compact: true,
    };
  });
}

export function countOpenQuestionsDisplayLines(items: OpenQuestionListItemRender[]): number {
  return items.reduce((sum, item) => sum + item.lines.length, 0);
}

export function resolveOpenQuestionsPaneLayout(params: {
  openQuestions: OpenQuestion[];
  selectedIndex: number;
  contentWidth: number;
  terminalRows: number;
}): OpenQuestionsPaneLayout {
  const totalCount = params.openQuestions.length;
  const selectedIndex = clampOpenQuestionSelectionIndex(params.selectedIndex, totalCount);
  const { titleText, titleLineCount } = formatOpenQuestionsPaneTitle(
    selectedIndex,
    totalCount,
    params.contentWidth,
  );

  if (totalCount === 0) {
    return {
      paneHeight: OPEN_QUESTIONS_PANE_MIN_HEIGHT,
      titleLineCount,
      titleText,
      contentLineCount: 1,
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
  let items = fullItems;
  let contentLineCount = Math.max(1, countOpenQuestionsDisplayLines(fullItems));

  if (contentLineCount > maxContentLines) {
    const selectedQuestion = params.openQuestions[selectedIndex];
    if (selectedQuestion) {
      items = [buildSelectedQuestionItem(selectedQuestion, params.contentWidth)];
      contentLineCount = Math.min(
        maxContentLines,
        Math.max(1, countOpenQuestionsDisplayLines(items)),
      );
    } else {
      contentLineCount = maxContentLines;
    }
  }

  const paneHeight = Math.max(
    OPEN_QUESTIONS_PANE_MIN_HEIGHT,
    PANE_BORDER_ROWS + titleLineCount + contentLineCount,
  );

  return {
    paneHeight,
    titleLineCount,
    titleText,
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
