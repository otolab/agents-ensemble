import type { SessionDialogueLog } from './dialogue-log.js';
import { formatOpenQuestionEnqueuedReport } from './format-registry-update.js';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';

export const MAX_TURNS_OPEN_QUESTION_TEXT = '次どうする？';

export interface EnsureMaxTurnsOpenQuestionInput {
  issueUrl: string;
  autonomousTurns: number;
  maxTurns: number;
  turnCount: number;
  workerDispatchCount: number;
  workerFailureCount: number;
  lastResult?: string;
}

/** 自律ターン上限到達時に orchestrator が登録する open question。 */
export function ensureMaxTurnsOpenQuestion(
  registry: OpenQuestionRegistry,
  dialogueLog: SessionDialogueLog,
  input: EnsureMaxTurnsOpenQuestionInput,
  onEnqueued?: (question: OpenQuestion) => void,
): OpenQuestion {
  const existing = registry
    .listOpen()
    .find((question) => question.source === 'max_turns');
  if (existing) return existing;

  const context = [
    `Issue: ${input.issueUrl}`,
    `自律ターン: ${input.autonomousTurns}/${input.maxTurns}`,
    `conductor ターン完了: ${input.turnCount}`,
    `worker 完了: ${input.workerDispatchCount}, 失敗: ${input.workerFailureCount}`,
    input.lastResult
      ? `直近の conductor 応答:\n${input.lastResult}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');

  const entry = registry.enqueue({
    question: MAX_TURNS_OPEN_QUESTION_TEXT,
    responseType: 'text',
    context,
    source: 'max_turns',
  });
  dialogueLog.appendRegistryUpdate(formatOpenQuestionEnqueuedReport(entry));
  onEnqueued?.(entry);
  return entry;
}
