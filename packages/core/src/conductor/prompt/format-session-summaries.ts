import type { ReviewerDispatchResult } from '../../dispatch/reviewer-dispatch.js';
import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../../escalation/human-inquiry.js';

export function formatDispatchSummaries(
  workers: WorkerDispatchResult[],
  reviewers: ReviewerDispatchResult[],
): string[] {
  if (workers.length === 0 && reviewers.length === 0) {
    return ['(なし)'];
  }

  const lines: string[] = [];

  for (const worker of workers) {
    lines.push(
      `- worker: issue=${worker.issue.url} skill worktree=${worker.worktree.path} stopReason=${worker.promptResult.stopReason}`,
    );
  }

  for (const reviewer of reviewers) {
    lines.push(
      `- reviewer: pr=${reviewer.prUrl} worktree=${reviewer.worktreePath} stopReason=${reviewer.promptResult.stopReason}`,
    );
  }

  return lines;
}

export function formatEscalationSummaries(escalations: EscalationRecord[]): string[] {
  if (escalations.length === 0) {
    return ['(なし)'];
  }

  return escalations.map((entry) => {
    const approved =
      entry.approved === undefined ? '' : ` approved=${entry.approved}`;
    return `- Q: ${entry.question} → A: ${entry.answer}${approved}`;
  });
}
