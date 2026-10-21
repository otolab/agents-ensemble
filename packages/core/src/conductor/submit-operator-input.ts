import { applyOperatorMessage } from '../escalation/apply-operator-message.js';
import { formatOpenQuestionAnsweredReport, joinOperatorInput } from '../escalation/format-registry-update.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { SessionLogger } from './session/session-logger.js';
import type { SessionEventQueue } from './session/session-event-queue.js';
import type {
  OperatorMessageDelivery,
  OperatorMessageEvent,
} from './session/session-event.js';

export interface SubmitOperatorInputInput {
  message: string;
  targetOpenQuestionId?: string;
  delivery?: OperatorMessageDelivery;
  answeredAt?: number;
  conductorTurn: number;
  openQuestions: OpenQuestionRegistry;
  escalations: EscalationRecord[];
  eventQueue: SessionEventQueue;
  sessionLogger: Pick<SessionLogger, 'emit'>;
  onEscalated?: (record: EscalationRecord) => void;
  onOperatorMessageQueued?: (event: OperatorMessageEvent) => void;
}

export interface EnqueueOperatorMessageInput {
  message: string;
  delivery?: OperatorMessageDelivery;
  conductorTurn: number;
  eventQueue: SessionEventQueue;
  sessionLogger: Pick<SessionLogger, 'emit'>;
  onOperatorMessageQueued?: (event: OperatorMessageEvent) => void;
}

/** キュー受理専用。Open Question や escalation の状態は参照・変更しない。 */
export function enqueueOperatorMessage(
  input: EnqueueOperatorMessageInput,
): boolean {
  const text = input.message.trim();
  if (!text) {
    return false;
  }

  const delivery = input.delivery ?? 'next';
  input.sessionLogger.emit({
    type: 'operator.input',
    conductorTurn: input.conductorTurn,
    text,
    delivery,
  });
  const event: OperatorMessageEvent = {
    type: 'operator.message',
    text,
    delivery,
  };
  input.onOperatorMessageQueued?.(event);
  input.eventQueue.enqueue(event);
  return true;
}

/** オペレータ発話を open question に適用し、conductor キューへ積む。 */
export function submitOperatorInput(input: SubmitOperatorInputInput): boolean {
  const trimmed = input.message.trim();
  if (!trimmed) {
    return false;
  }

  const applied = applyOperatorMessage(input.openQuestions, trimmed, {
    targetQuestionId: input.targetOpenQuestionId,
    answeredAt: input.answeredAt,
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

  return enqueueOperatorMessage({
    message: text,
    delivery: input.delivery,
    conductorTurn: input.conductorTurn,
    eventQueue: input.eventQueue,
    sessionLogger: input.sessionLogger,
    onOperatorMessageQueued: input.onOperatorMessageQueued,
  });
}
