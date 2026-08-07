import type { LibrarianDispatchResult } from '../../dispatch/librarian-dispatch.js';
import type { ReviewerDispatchResult } from '../../dispatch/reviewer-dispatch.js';
import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../../escalation/human-inquiry.js';
import type { WorkerFailureRecord } from '../../runtime/types.js';

export function formatDispatchSummaries(
  workers: WorkerDispatchResult[],
  reviewers: ReviewerDispatchResult[],
  librarians: LibrarianDispatchResult[] = [],
): string[] {
  if (workers.length === 0 && reviewers.length === 0 && librarians.length === 0) {
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

  for (const librarian of librarians) {
    lines.push(
      `- librarian: skill=${librarian.skillName} cwd=${librarian.cwd} stopReason=${librarian.promptResult.stopReason}`,
    );
  }

  return lines;
}

export function formatWorkerFailureSummaries(
  failures: WorkerFailureRecord[],
): string[] {
  if (failures.length === 0) {
    return ['(なし)'];
  }

  return failures.map(
    (failure) =>
      `- worker failed: id=${failure.workerId} issue=${failure.issueUrl} skill=${failure.skillName} error=${failure.error}`,
  );
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
