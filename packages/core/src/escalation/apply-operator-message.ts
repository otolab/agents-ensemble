import type { SessionDialogueLog } from './dialogue-log.js';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';
import { recordOpenQuestionAnswer } from './record-open-question-answer.js';

const INQUIRY_REFERENCE_PATTERN = /^@inq:([^\s]+)\s+([\s\S]+)$/u;

export interface ApplyOperatorMessageResult {
  /** オペレータメッセージで回答が確定した質問。 */
  answered: OpenQuestion[];
  /** 質問 id に紐づかなかった一般指示（イベント列の operator.message に載せる）。 */
  generalGuidance?: string;
}

export function applyOperatorMessage(
  registry: OpenQuestionRegistry,
  dialogueLog: SessionDialogueLog,
  message: string,
): ApplyOperatorMessageResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { answered: [] };
  }

  const explicit = trimmed.match(INQUIRY_REFERENCE_PATTERN);
  if (explicit) {
    const [, id, answerText] = explicit;
    const answered = recordOpenQuestionAnswer(registry, dialogueLog, {
      id: id!,
      answer: answerText.trim(),
      answeredBy: 'operator',
      sourceMessage: trimmed,
    });
    return answered
      ? { answered: [answered] }
      : { answered: [], generalGuidance: trimmed };
  }

  const open = registry.listOpen();
  if (open.length === 1) {
    const answered = recordOpenQuestionAnswer(registry, dialogueLog, {
      id: open[0]!.id,
      answer: trimmed,
      answeredBy: 'operator',
      sourceMessage: trimmed,
    });
    return answered
      ? { answered: [answered] }
      : { answered: [], generalGuidance: trimmed };
  }

  return { answered: [], generalGuidance: trimmed };
}
