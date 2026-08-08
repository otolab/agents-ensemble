import type { OpenQuestion } from './open-question.js';

export function formatOpenQuestionEnqueuedReport(question: OpenQuestion): string {
  const context = question.context ? `\ncontext: ${question.context}` : '';
  const permission = question.relatedPermissionId
    ? `\npermission: ${question.relatedPermissionId}`
    : '';
  return `【open question 登録】${question.id} [${question.responseType}]: ${question.question}${context}${permission}`;
}

export function formatOpenQuestionAnsweredReport(question: OpenQuestion): string {
  const approved =
    question.approved === undefined ? '' : `\napproved: ${question.approved}`;
  return `【open question 回答】${question.id}: ${question.question} → ${question.answer} (by ${question.answeredBy})${approved}`;
}

export function joinOperatorInput(parts: Array<string | undefined>): string | undefined {
  const lines = parts.map((part) => part?.trim()).filter((part) => part);
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}
