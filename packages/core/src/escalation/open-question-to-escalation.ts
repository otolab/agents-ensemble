import type { EscalationRecord } from './human-inquiry.js';
import type { OpenQuestion } from './open-question.js';

export function openQuestionToEscalationRecord(
  question: OpenQuestion,
): EscalationRecord | undefined {
  if (question.status !== 'answered' || !question.answer) {
    return undefined;
  }

  return {
    question: question.question,
    responseType: question.responseType,
    context: question.context,
    answer: question.answer,
    approved: question.approved,
  };
}
