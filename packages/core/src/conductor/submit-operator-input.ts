import { applyOperatorMessage } from '../escalation/apply-operator-message.js';
import { formatOpenQuestionAnsweredReport, joinOperatorInput } from '../escalation/format-registry-update.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { SessionLogger } from './session/session-logger.js';
import type { SessionEventQueue } from './session/session-event-queue.js';

export interface SubmitOperatorInputInput {
  message: string;
  targetOpenQuestionId?: string;
  conductorTurn: number;
  openQuestions: OpenQuestionRegistry;
  escalations: EscalationRecord[];
  eventQueue: SessionEventQueue;
  sessionLogger: SessionLogger;
  onEscalated?: (record: EscalationRecord) => void;
}

/** オペレータ発話を open question に適用し、conductor キューへ積む。 */
export function submitOperatorInput(input: SubmitOperatorInputInput): boolean {
  const trimmed = input.message.trim();
  if (!trimmed) {
    return false;
  }

  const applied = applyOperatorMessage(input.openQuestions, trimmed, {
    targetQuestionId: input.targetOpenQuestionId,
  });
  const text =
    applied.answered.length > 0
      ? joinOperatorInput([
          applied.generalGuidance,
          ...applied.answered.map(formatOpenQuestionAnsweredReport),
        ])
      : joinOperatorInput([applied.generalGuidance ?? trimmed]);

  for (const answered of applied.answered) {
    const record = openQuestionToEscalationRecord(answered);
    if (record) {
      input.escalations.push(record);
      input.sessionLogger.emit({ type: 'escalation.recorded', record });
      input.onEscalated?.(record);
    }
  }

  if (!text) {
    return false;
  }

  input.sessionLogger.emit({
    type: 'operator.input',
    conductorTurn: input.conductorTurn,
    text,
  });
  input.eventQueue.enqueue({ type: 'operator.message', text });
  return true;
}
