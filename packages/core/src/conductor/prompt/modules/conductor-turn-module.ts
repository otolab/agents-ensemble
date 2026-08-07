import type { PromptModule } from '@modular-prompt/core';
import { formatIssueContextForPrompt } from '../../../github/issue-context.js';
import {
  formatDispatchSummaries,
  formatEscalationSummaries,
} from '../format-session-summaries.js';
import type { ConductorPromptContext } from '../types.js';

/** ターンごとの更新（Issue 再読・dispatch 結果など）。 */
export const conductorTurnModule: PromptModule<ConductorPromptContext> = {
  objective: [
    (ctx) => {
      if (ctx.humanGuidance) {
        return '人間オペレータからの指示を踏まえ、次の dispatch を判断する。';
      }
      if (ctx.turn && ctx.turn > 1) {
        return '前ターンの結果を踏まえ、Issue / PR を再読して次の dispatch を判断する。';
      }
      return 'Issue / PR を読み、次に必要な dispatch を判断する。';
    },
  ],
  inputs: [
    (ctx) =>
      ctx.turn && ctx.maxTurns ? `ターン: ${ctx.turn} / ${ctx.maxTurns}` : null,
    (ctx) => `作業リポジトリ（ローカル）: ${ctx.repoRoot}`,
    (ctx) => formatIssueContextForPrompt(ctx.issueContext),
    (ctx) => (ctx.followUp ? `追加指示: ${ctx.followUp}` : null),
    (ctx) =>
      ctx.humanGuidance
        ? `人間オペレータからの指示:\n${ctx.humanGuidance}`
        : null,
  ],
  state: [
    (ctx) => {
      const running = ctx.runningWorkers ?? [];
      if (running.length === 0) return null;
      return [
        '実行中の worker',
        ...running.map(
          (worker) =>
            `- ${worker.workerId}: issue=${worker.issueUrl} skill=${worker.skillName}`,
        ),
      ].join('\n');
    },
    (ctx) => {
      const workers = ctx.workerDispatches ?? [];
      const reviewers = ctx.reviewerDispatches ?? [];
      if (workers.length === 0 && reviewers.length === 0) return null;
      return [
        '直近の dispatch 結果',
        ...formatDispatchSummaries(workers, reviewers),
      ].join('\n');
    },
    (ctx) => {
      const escalations = ctx.escalations ?? [];
      if (escalations.length === 0) return null;
      return [
        '人間へのエスカレーション',
        ...formatEscalationSummaries(escalations),
      ].join('\n');
    },
  ],
};
