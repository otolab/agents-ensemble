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
import { CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT } from './conductor-recovery-inbox.js';

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
  /** Original operator text when `message` includes generated Open Question context. */
  operatorInput?: string;
  delivery?: OperatorMessageDelivery;
  conductorTurn: number;
  eventQueue: SessionEventQueue;
  sessionLogger: Pick<SessionLogger, 'emit'>;
  onOperatorMessageQueued?: (event: OperatorMessageEvent) => void;
  openQuestionAnswer?: boolean;
  answerPreview?: string;
}

/** キュー受理専用。Open Question や escalation の状態は参照・変更しない。 */
export function enqueueOperatorMessage(
  input: EnqueueOperatorMessageInput,
): boolean {
  const text = input.message.trim();
  if (!text) {
    return false;
  }
  const operatorInput = input.operatorInput?.trim() || text;
  if (!isOperatorInputWithinRecoveryLimit(operatorInput)) {
    emitOversizedOperatorInputWarning(input.sessionLogger);
    return false;
  }

  const delivery = input.delivery ?? 'next';
  const event: OperatorMessageEvent = {
    type: 'operator.message',
    text,
    ...(operatorInput !== text ? { operatorInput } : {}),
    delivery,
    ...(input.openQuestionAnswer ? { openQuestionAnswer: true } : {}),
    ...(input.answerPreview ? { answerPreview: input.answerPreview } : {}),
  };
  input.onOperatorMessageQueued?.(event);
  input.eventQueue.enqueue(event);
  input.sessionLogger.emit({
    type: 'operator.input',
    conductorTurn: input.conductorTurn,
    text,
    delivery,
  });
  return true;
}

/** オペレータ発話を open question に適用し、conductor キューへ積む。 */
export function submitOperatorInput(input: SubmitOperatorInputInput): boolean {
  const trimmed = input.message.trim();
  if (!trimmed) {
    return false;
  }
  if (!isOperatorInputWithinRecoveryLimit(trimmed)) {
    emitOversizedOperatorInputWarning(input.sessionLogger);
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
    ...(text !== trimmed ? { operatorInput: trimmed } : {}),
    delivery: input.delivery,
    conductorTurn: input.conductorTurn,
    eventQueue: input.eventQueue,
    sessionLogger: input.sessionLogger,
    onOperatorMessageQueued: input.onOperatorMessageQueued,
    openQuestionAnswer: applied.answered.length > 0,
    answerPreview: applied.answered
      .map((question) => `${question.id}: ${question.answer ?? ''}`)
      .join(' / ') || undefined,
  });
}

export function isOperatorInputWithinRecoveryLimit(message: string): boolean {
  return Buffer.byteLength(message, 'utf8') <= CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT;
}

function emitOversizedOperatorInputWarning(
  sessionLogger: Pick<SessionLogger, 'emit'>,
): void {
  sessionLogger.emit({
    type: 'harness.warning',
    message:
      'recovery inbox で内容を完全に保持するため、1 MiB を超える入力は受け付けません。短くするか分割してから送信してください。',
  });
}
