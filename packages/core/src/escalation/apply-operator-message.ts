import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';
import { recordOpenQuestionAnswer } from './record-open-question-answer.js';

export interface ApplyOperatorMessageOptions {
  /** 回答先の open question id（TUI 選択など）。 */
  targetQuestionId?: string;
}

export interface ApplyOperatorMessageResult {
  /** オペレータメッセージで回答が確定した質問。 */
  answered: OpenQuestion[];
  /** 質問 id に紐づかなかった一般指示（イベント列の operator.message に載せる）。 */
  generalGuidance?: string;
}

export function applyOperatorMessage(
  registry: OpenQuestionRegistry,
  message: string,
  options?: ApplyOperatorMessageOptions,
): ApplyOperatorMessageResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { answered: [] };
  }

  if (options?.targetQuestionId) {
    const answered = recordOpenQuestionAnswer(registry, {
      id: options.targetQuestionId,
      answer: trimmed,
      answeredBy: 'operator',
      sourceMessage: trimmed,
    });
    return answered
      ? { answered: [answered] }
      : { answered: [], generalGuidance: trimmed };
  }

  const open = registry.listOpen();
  if (open.length === 1) {
    const answered = recordOpenQuestionAnswer(registry, {
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
