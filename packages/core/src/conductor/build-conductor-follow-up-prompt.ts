import type { ReviewerDispatchResult } from '../dispatch/reviewer-dispatch.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import type { IssueContext } from '../github/issue-context.js';
import { formatIssueContextForPrompt } from '../github/issue-context.js';

export interface BuildConductorFollowUpPromptOptions {
  issueContext: IssueContext;
  repoRoot: string;
  turn: number;
  maxTurns: number;
  workerDispatches: WorkerDispatchResult[];
  reviewerDispatches: ReviewerDispatchResult[];
  escalations?: EscalationRecord[];
}

export function buildConductorFollowUpPrompt(
  options: BuildConductorFollowUpPromptOptions,
): string {
  const lines = [
    '前ターンの dispatch 結果を踏まえ、Issue / PR の最新状態を読み直して次のアクションを判断してください。',
    '',
    `ターン: ${options.turn} / ${options.maxTurns}`,
    `作業リポジトリ（ローカル）: ${options.repoRoot}`,
    '',
    formatIssueContextForPrompt(options.issueContext),
    '',
    '## 直近の dispatch 結果',
    ...formatDispatchSummaries(
      options.workerDispatches,
      options.reviewerDispatches,
    ),
    '',
    '## 人間へのエスカレーション',
    ...formatEscalationSummaries(options.escalations ?? []),
    '',
    '## 次の判断',
    '- 作業が必要なら `dispatch_worker`',
    '- PR レビューが必要なら `dispatch_reviewer`（既存 worktree を使用）',
    '- 判断不能・マージ判断などは `ask_human` で人間に確認',
    '- 人間レビュー待ちなら Issue に状況を書き、追加 dispatch はせず終了',
    '- 完了なら追加 dispatch はせず終了',
  ];

  return lines.join('\n');
}

function formatDispatchSummaries(
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

function formatEscalationSummaries(escalations: EscalationRecord[]): string[] {
  if (escalations.length === 0) {
    return ['(なし)'];
  }

  return escalations.map((entry) => {
    const approved =
      entry.approved === undefined ? '' : ` approved=${entry.approved}`;
    return `- Q: ${entry.question} → A: ${entry.answer}${approved}`;
  });
}
