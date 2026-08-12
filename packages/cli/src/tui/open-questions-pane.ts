import type { OpenQuestion } from '@agents-ensemble/core';
import { wrapTextToWidth } from './wrap-text-to-width.js';
import {
  OPEN_QUESTIONS_SCROLL_HINT,
  PANE_BORDER_ROWS,
} from './tui-layout-constants.js';

export type OpenQuestionsScrollAction = 'pageUp' | 'pageDown' | 'home' | 'end';

/** `linesFromTop=0` が先頭表示。PgDn で増加（下へ）、Home で 0 に復帰。 */
export function advanceOpenQuestionsScrollOffset(
  linesFromTop: number,
  action: OpenQuestionsScrollAction,
  pageSize: number,
  maxLinesFromTop: number,
): number {
  switch (action) {
    case 'pageUp':
      return Math.max(0, linesFromTop - pageSize);
    case 'pageDown':
      return Math.min(linesFromTop + pageSize, maxLinesFromTop);
    case 'home':
      return 0;
    case 'end':
      return maxLinesFromTop;
  }
}

/** Open question 1 件ずつ折り返し済みの表示行に展開。 */
export function buildOpenQuestionDisplayLines(
  openQuestions: OpenQuestion[],
  contentWidth: number,
): string[] {
  const lines: string[] = [];

  for (const question of openQuestions) {
    lines.push(
      ...wrapTextToWidth(
        `- ${question.id} [${question.responseType}] ${question.question}`,
        contentWidth,
      ),
    );
    if (question.context) {
      lines.push(...wrapTextToWidth(`  ${question.context}`, contentWidth));
    }
  }

  return lines;
}

/** 表示行配列から可視範囲を切り出す。`linesFromTop=0` が先頭表示。 */
export function sliceOpenQuestionDisplayLines(
  lines: string[],
  visibleCount: number,
  linesFromTop: number,
): string[] {
  if (lines.length === 0 || visibleCount < 1) {
    return [];
  }

  const maxOffset = Math.max(0, lines.length - visibleCount);
  const offset = Math.min(Math.max(0, linesFromTop), maxOffset);
  return lines.slice(offset, offset + visibleCount);
}

/** Open questions ペイン内に表示できる本文行数。 */
export function computeOpenQuestionsContentLineCount(
  paneHeight: number,
  titleLineCount: number,
): number {
  return Math.max(1, paneHeight - PANE_BORDER_ROWS - titleLineCount);
}

export function getOpenQuestionsTitleLineCount(
  scrollHint: string,
  contentWidth: number,
): number {
  return wrapTextToWidth(`Open questions${scrollHint}`, contentWidth).length;
}

/** 溢れ時は初回表示からスクロールヒント付きタイトルを返す。 */
export function resolveOpenQuestionsScrollLayout(params: {
  displayLineCount: number;
  paneHeight: number;
  contentWidth: number;
}): {
  scrollHint: string;
  titleLineCount: number;
  visibleLineCount: number;
  isScrollable: boolean;
} {
  const titleLineCountWithoutHint = getOpenQuestionsTitleLineCount('', params.contentWidth);
  const visibleLineCountWithoutHint = computeOpenQuestionsContentLineCount(
    params.paneHeight,
    titleLineCountWithoutHint,
  );

  if (params.displayLineCount <= visibleLineCountWithoutHint) {
    return {
      scrollHint: '',
      titleLineCount: titleLineCountWithoutHint,
      visibleLineCount: visibleLineCountWithoutHint,
      isScrollable: false,
    };
  }

  const scrollHint = OPEN_QUESTIONS_SCROLL_HINT;
  const titleLineCount = getOpenQuestionsTitleLineCount(scrollHint, params.contentWidth);
  const visibleLineCount = computeOpenQuestionsContentLineCount(
    params.paneHeight,
    titleLineCount,
  );

  return {
    scrollHint,
    titleLineCount,
    visibleLineCount,
    isScrollable: params.displayLineCount > visibleLineCount,
  };
}
