import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../../escalation/human-inquiry.js';
import type { WorkerFailureRecord } from '../../runtime/types.js';

export function formatDispatchSummaries(
  workers: WorkerDispatchResult[],
): string[] {
  if (workers.length === 0) {
    return ['(なし)'];
  }

  return workers.map(
    (worker) =>
      `- worker: name=${worker.name} kind=${worker.kind} issue=${worker.issue.url} worktree=${worker.worktree.path} stopReason=${worker.promptResult.stopReason}${formatResponseSuffix(worker.promptResult.responseText)}`,
  );
}

function formatResponseSuffix(responseText: string | undefined): string {
  if (!responseText) return '';
  const trimmed = responseText.trim();
  if (!trimmed) return '';
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  return ` response=${preview}`;
}

export function formatWorkerFailureSummaries(
  failures: WorkerFailureRecord[],
): string[] {
  if (failures.length === 0) {
    return ['(なし)'];
  }

  return failures.map(
    (failure) =>
      `- worker failed: id=${failure.workerId} name=${failure.name} issue=${failure.issueUrl} kind=${failure.kind} error=${failure.error}`,
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
