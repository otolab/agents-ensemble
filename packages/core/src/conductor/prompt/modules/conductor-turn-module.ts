import type { PromptModule } from '@modular-prompt/core';
import { formatIssueContextForPrompt } from '../../../github/issue-context.js';
import {
  formatDispatchSummaries,
  formatEscalationSummaries,
  formatWorkerFailureSummaries,
} from '../format-session-summaries.js';
import { formatPendingPermissionSummaries } from '../../../permission/format-pending-permissions.js';
import type { ConductorPromptContext } from '../types.js';

/** ターンごとの更新（Issue 再読・worker 状態など）。 */
export const conductorTurnModule: PromptModule<ConductorPromptContext> = {
  objective: [
    (ctx) => {
      if (ctx.humanGuidance) {
        return '人間オペレータからの指示を踏まえ、Issue / PR と worker の状態を確認する。';
      }
      if (ctx.turn && ctx.turn > 1) {
        return '前ターンの結果を踏まえ、Issue / PR と worker の状態を確認する。';
      }
      return 'Issue / PR を読み、worker の状態を確認する。';
    },
  ],
  inputs: [
    (ctx) => (ctx.turn ? `conductor ターン: ${ctx.turn}` : null),
    (ctx) =>
      ctx.maxTurns != null
        ? `自律ターン（直近オペレータ入力から）: ${ctx.autonomousTurns ?? 0} / ${ctx.maxTurns}`
        : null,
    (ctx) => `対象 clone（ローカル）: ${ctx.repoRoot}`,
    (ctx) => formatIssueContextForPrompt(ctx.issueContext),
    (ctx) => (ctx.followUp ? `追加指示: ${ctx.followUp}` : null),
    (ctx) =>
      ctx.humanGuidance
        ? `人間オペレータからの入力:\n${ctx.humanGuidance}`
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
            `- ${worker.name} (${worker.kind}): id=${worker.workerId} issue=${worker.issueUrl}`,
        ),
      ].join('\n');
    },
    (ctx) => {
      const pending = ctx.pendingPermissions ?? [];
      if (pending.length === 0) return null;
      return [
        '判断待ちの worker permission（resolve_permission で allow/deny。要確認時は ask_human）',
        ...formatPendingPermissionSummaries(pending),
      ].join('\n');
    },
    (ctx) => {
      const workers = ctx.workerDispatches ?? [];
      if (workers.length === 0) return null;
      return [
        '完了した worker',
        ...formatDispatchSummaries(workers),
      ].join('\n');
    },
    (ctx) => {
      const failures = ctx.workerFailures ?? [];
      if (failures.length === 0) return null;
      return [
        'worker 失敗',
        ...formatWorkerFailureSummaries(failures),
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
