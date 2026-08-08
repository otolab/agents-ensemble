import type { OpenQuestion } from './open-question.js';

export function formatOpenQuestionSummaries(
  questions: OpenQuestion[],
): string[] {
  if (questions.length === 0) {
    return ['(なし)'];
  }

  return questions.map((entry) => {
    const context = entry.context ? ` context=${entry.context}` : '';
    const permission = entry.relatedPermissionId
      ? ` permission=${entry.relatedPermissionId}`
      : '';
    return `- id=${entry.id} [${entry.responseType}] ${entry.question}${context}${permission}`;
  });
}

export function formatAnsweredOpenQuestionSummaries(
  questions: OpenQuestion[],
): string[] {
  if (questions.length === 0) {
    return ['(なし)'];
  }

  return questions.map((entry) => {
    const approved =
      entry.approved === undefined ? '' : ` approved=${entry.approved}`;
    const answeredBy = entry.answeredBy ? ` by=${entry.answeredBy}` : '';
    return `- id=${entry.id} Q: ${entry.question} → A: ${entry.answer}${approved}${answeredBy}`;
  });
}
