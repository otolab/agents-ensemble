import type { IssueSessionResult } from '../conductor/issue-session.js';
import type { HumanInquiryRequest } from './human-inquiry.js';

export function buildMaxTurnsEscalationRequest(
  result: IssueSessionResult,
): HumanInquiryRequest {
  const dispatchSummary = [
    `worker 完了: ${result.workerDispatches.length}`,
    `worker 失敗: ${result.workerFailures.length}`,
    `turns completed: ${result.turnCount}`,
  ].join(', ');

  return {
    kind: 'escalation',
    responseType: 'text',
    question:
      'Conductor reached max turns. How should orchestration continue?',
    context: [
      `Issue: ${result.issueUrl}`,
      dispatchSummary,
      result.lastResult
        ? `Last conductor message:\n${result.lastResult}`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}
