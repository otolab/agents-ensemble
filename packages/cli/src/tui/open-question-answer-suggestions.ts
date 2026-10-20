import type { OpenQuestion } from '@agents-ensemble/core';
import { wrapTextToWidth } from './wrap-text-to-width.js';

export interface OpenQuestionAnswerSuggestion {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly matchPrefixes: readonly string[];
}

export interface OpenQuestionAnswerSuggestionLine {
  readonly id: string;
  readonly text: string;
  readonly isSelected: boolean;
}

/** 選択中の choice / yes_no 質問に対する単一行 prefix 候補を返す。 */
export function getOpenQuestionAnswerSuggestions(
  input: string,
  question: OpenQuestion | undefined,
): OpenQuestionAnswerSuggestion[] {
  if (/[\r\n\u2028\u2029]/u.test(input) || !question) {
    return [];
  }

  const candidates: OpenQuestionAnswerSuggestion[] =
    question.responseType === 'choice' && (question.choices?.length ?? 0) > 0
      ? question.choices!.map((choice, index) => ({
          id: `choice-${index}-${choice.id}`,
          value: choice.id,
          label: `${choice.id}: ${choice.label}`,
          matchPrefixes: [choice.id, choice.label, String(index + 1)],
        }))
      : question.responseType === 'yes_no'
        ? [
            {
              id: 'yes',
              value: 'yes',
              label: 'yes — はい',
              matchPrefixes: ['yes', 'y', 'はい'],
            },
            {
              id: 'no',
              value: 'no',
              label: 'no — いいえ',
              matchPrefixes: ['no', 'n', 'いいえ'],
            },
          ]
        : [];

  const prefix = normalizePrefix(input);
  return candidates.filter((candidate) =>
    candidate.matchPrefixes.some((matchPrefix) =>
      normalizePrefix(matchPrefix).startsWith(prefix),
    ),
  );
}

/** 候補 index を上下へ進める。リスト端では循環せず、その場に留まる。 */
export function advanceOpenQuestionAnswerSuggestionSelection(
  selectedIndex: number,
  direction: 'up' | 'down',
  suggestionCount: number,
): number {
  if (suggestionCount <= 0) {
    return 0;
  }

  const currentIndex = Math.min(
    Math.max(selectedIndex, 0),
    suggestionCount - 1,
  );
  const offset = direction === 'up' ? -1 : 1;
  return Math.min(Math.max(currentIndex + offset, 0), suggestionCount - 1);
}

/** 入力ペインの高さ計算に使う候補表示行を作る。 */
export function getOpenQuestionAnswerSuggestionLines(
  suggestions: OpenQuestionAnswerSuggestion[],
  contentWidth: number,
  selectedIndex = 0,
): OpenQuestionAnswerSuggestionLine[] {
  const width = Math.max(1, Math.floor(contentWidth));
  const markerWidth = width >= 3 ? 2 : width >= 2 ? 1 : 0;
  const textWidth = Math.max(1, width - markerWidth);
  const unselectedMarker = ' '.repeat(markerWidth);
  const selectedMarker = markerWidth === 2 ? '› ' : markerWidth === 1 ? '›' : '';
  const boundedSelectedIndex = Math.min(
    Math.max(selectedIndex, 0),
    Math.max(0, suggestions.length - 1),
  );

  return suggestions.flatMap((suggestion, suggestionIndex) => {
    const isSelected = suggestionIndex === boundedSelectedIndex;
    return wrapTextToWidth(suggestion.label, textWidth).map((line, lineIndex) => ({
      id: `${suggestion.id}-${lineIndex}`,
      text: `${isSelected && lineIndex === 0 ? selectedMarker : unselectedMarker}${line}`,
      isSelected,
    }));
  });
}

function normalizePrefix(value: string): string {
  return value.replace(/^[\t ]+/u, '').normalize('NFKC').toLowerCase();
}
