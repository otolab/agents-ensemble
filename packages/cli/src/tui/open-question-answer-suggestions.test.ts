import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '@agents-ensemble/core';
import {
  advanceOpenQuestionAnswerSuggestionSelection,
  getOpenQuestionAnswerSuggestionLines,
  getOpenQuestionAnswerSuggestions,
} from './open-question-answer-suggestions.js';

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

describe('open question answer suggestions', () => {
  const choiceQuestion = createQuestion({
    id: 'inq-choice',
    question: 'Choose a mode',
    responseType: 'choice',
    choices: [
      { id: 'fast', label: 'Fast mode' },
      { id: 'safe', label: 'Safe mode' },
    ],
  });

  it('lists choice candidates and filters by case-insensitive id, label, and one-based index', () => {
    expect(
      getOpenQuestionAnswerSuggestions('', choiceQuestion).map(({ value }) => value),
    ).toEqual(['fast', 'safe']);
    expect(
      getOpenQuestionAnswerSuggestions('SA', choiceQuestion).map(({ value }) => value),
    ).toEqual(['safe']);
    expect(
      getOpenQuestionAnswerSuggestions('fast m', choiceQuestion).map(({ value }) => value),
    ).toEqual(['fast']);
    expect(
      getOpenQuestionAnswerSuggestions('2', choiceQuestion).map(({ value }) => value),
    ).toEqual(['safe']);
  });

  it('offers yes/no values accepted by the existing parser with English and Japanese prefixes', () => {
    const question = createQuestion({
      id: 'inq-yes-no',
      question: 'Proceed?',
      responseType: 'yes_no',
    });

    expect(
      getOpenQuestionAnswerSuggestions('', question).map(({ value }) => value),
    ).toEqual(['yes', 'no']);
    expect(
      getOpenQuestionAnswerSuggestions('Y', question).map(({ value }) => value),
    ).toEqual(['yes']);
    expect(
      getOpenQuestionAnswerSuggestions('は', question).map(({ value }) => value),
    ).toEqual(['yes']);
    expect(
      getOpenQuestionAnswerSuggestions('い', question).map(({ value }) => value),
    ).toEqual(['no']);
    expect(
      getOpenQuestionAnswerSuggestions(' N', question).map(({ value }) => value),
    ).toEqual(['no']);
  });

  it('does not suggest for text questions, empty choice lists, or multiline input', () => {
    const textQuestion = createQuestion({
      id: 'inq-text',
      question: 'Anything else?',
      responseType: 'text',
    });
    const emptyChoiceQuestion = createQuestion({
      id: 'inq-empty-choice',
      question: 'Choose?',
      responseType: 'choice',
      choices: [],
    });

    expect(getOpenQuestionAnswerSuggestions('', textQuestion)).toEqual([]);
    expect(getOpenQuestionAnswerSuggestions('', emptyChoiceQuestion)).toEqual([]);
    expect(getOpenQuestionAnswerSuggestions('fast\nmode', choiceQuestion)).toEqual([]);
    expect(getOpenQuestionAnswerSuggestions('fast\u2028mode', choiceQuestion)).toEqual([]);
    expect(getOpenQuestionAnswerSuggestions('', undefined)).toEqual([]);
  });

  it('renders wrapped candidate rows with a bounded selected marker', () => {
    const suggestions = getOpenQuestionAnswerSuggestions('', choiceQuestion);
    const rows = getOpenQuestionAnswerSuggestionLines(suggestions, 18, 1);

    expect(rows.some(({ text, isSelected }) => isSelected && text.startsWith('› '))).toBe(true);
    expect(rows.some(({ text, isSelected }) => !isSelected && text.startsWith('  '))).toBe(true);
    expect(rows.map(({ text }) => text).join('\n')).toContain('safe: Safe mode');
  });

  it('moves the selected candidate without wrapping at either boundary', () => {
    expect(advanceOpenQuestionAnswerSuggestionSelection(0, 'up', 2)).toBe(0);
    expect(advanceOpenQuestionAnswerSuggestionSelection(0, 'down', 2)).toBe(1);
    expect(advanceOpenQuestionAnswerSuggestionSelection(1, 'down', 2)).toBe(1);
    expect(advanceOpenQuestionAnswerSuggestionSelection(1, 'up', 2)).toBe(0);
    expect(advanceOpenQuestionAnswerSuggestionSelection(4, 'up', 0)).toBe(0);
  });
});
