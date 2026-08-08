import type { SessionDialogueLog } from './dialogue-log.js';
import { formatOpenQuestionAnsweredReport } from './format-registry-update.js';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';

export interface RecordOpenQuestionAnswerInput {
  id: string;
  answer: string;
  approved?: boolean;
  answeredBy: 'operator' | 'conductor';
  sourceMessage?: string;
  rationale?: string;
}

export function recordOpenQuestionAnswer(
  registry: OpenQuestionRegistry,
  dialogueLog: SessionDialogueLog,
  input: RecordOpenQuestionAnswerInput,
): OpenQuestion | undefined {
  const entry = registry.get(input.id);
  if (!entry || entry.status !== 'open') return undefined;

  const approved =
    input.approved ??
    (entry.responseType === 'yes_no'
      ? input.answer.trim().toLowerCase().startsWith('y')
      : undefined);

  const answered = registry.answer(input.id, {
    answer: input.answer,
    approved,
    answeredBy: input.answeredBy,
    sourceMessage: input.sourceMessage,
    rationale: input.rationale,
  });
  if (!answered) return undefined;

  const report = formatOpenQuestionAnsweredReport(answered);
  dialogueLog.appendRegistryUpdate(report);

  return answered;
}
