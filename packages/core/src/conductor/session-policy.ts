import type { ConductorSendResult } from './conductor-agent.js';
import type { SessionEvent } from './session/session-event.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { WorkerSession } from '../runtime/worker-session.js';
import {
  createConductorCoreState,
  isMaxTurnsLimitedCore,
  stepConductorCore,
  type IssueLoopStopInput,
  type IssueLoopStopReason,
} from './conductor-transition-core.js';

export type { IssueLoopStopInput, IssueLoopStopReason };

export const DEFAULT_MAX_ISSUE_TURNS = 5;

/** `maxTurns` 未指定時はデフォルト、それ以外はそのまま（`<= 0` は無制限）。 */
export function resolveMaxTurns(maxTurns?: number): number {
  if (maxTurns === undefined) {
    return DEFAULT_MAX_ISSUE_TURNS;
  }
  return maxTurns;
}

/** 自律ターン上限が有効か（`maxTurns > 0`）。 */
export function isMaxTurnsLimited(maxTurns: number): boolean {
  return isMaxTurnsLimitedCore(maxTurns);
}

/** View 向けの `maxTurns`（無制限時は `null`）。 */
export function operatorInputMaxTurns(maxTurns: number): number | null {
  return isMaxTurnsLimited(maxTurns) ? maxTurns : null;
}

/** Issue session の conductor 自律ループを終了すべきか判定する（プロセス終了ではない）。 */
export function shouldStopIssueLoop(input: IssueLoopStopInput): boolean {
  const transition = stepConductorCore(createConductorCoreState(), {
    type: 'issueLoop.stopCheck',
    input,
  });
  const decision = transition.effects.find(
    (effect) =>
      effect.kind === 'action' && effect.action.type === 'issueLoopStop',
  );
  return (
    decision?.kind === 'action' &&
    decision.action.type === 'issueLoopStop' &&
    decision.action.shouldStop
  );
}

export function resolveIssueLoopStopReason(
  input: IssueLoopStopInput,
): IssueLoopStopReason {
  const transition = stepConductorCore(createConductorCoreState(), {
    type: 'issueLoop.stopCheck',
    input,
  });
  const decision = transition.effects.find(
    (effect) =>
      effect.kind === 'action' && effect.action.type === 'issueLoopStop',
  );
  return decision?.kind === 'action' &&
    decision.action.type === 'issueLoopStop'
    ? decision.action.stopReason
    : 'completed';
}

/** 自律ターン上限到達後も conductor へ送れるイベントか。 */
export function canDispatchConductorSend(
  event: SessionEvent,
  autonomousTurns: number,
  maxTurns: number,
): boolean {
  const transition = stepConductorCore(
    createConductorCoreState({ autonomousTurns }),
    {
      type: 'dispatch.canSend',
      event,
      maxTurns,
    },
  );
  const decision = transition.effects.find(
    (effect) =>
      effect.kind === 'action' && effect.action.type === 'dispatchGate',
  );
  return (
    decision?.kind === 'action' &&
    decision.action.type === 'dispatchGate' &&
    decision.action.allowed
  );
}

/** conductor send 完了後の `autonomousTurns`（オペレータ入力でリセット）。 */
export function autonomousTurnsAfterConductorSend(
  event: SessionEvent,
  autonomousTurns: number,
): number {
  const transition = stepConductorCore(
    createConductorCoreState({ autonomousTurns }),
    { type: 'dispatch.turnsAfterSend', event },
  );
  return transition.state.autonomousTurns;
}

/** 束 dispatch 後の `autonomousTurns`（束に operator が含まれればリセット）。 */
export function autonomousTurnsAfterConductorBatch(
  events: SessionEvent[],
  autonomousTurns: number,
): number {
  const transition = stepConductorCore(
    createConductorCoreState({ autonomousTurns }),
    { type: 'dispatch.turnsAfterBatch', events },
  );
  return transition.state.autonomousTurns;
}

export function buildIssueLoopStopInput(input: {
  autonomousTurns: number;
  maxTurns: number;
  lastSendResult: ConductorSendResult;
  dispatchesThisTurn: number;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  openQuestions: OpenQuestionRegistry;
  continueOnConductorError: boolean;
  stopOnUnansweredInput?: boolean;
}): IssueLoopStopInput {
  return {
    autonomousTurns: input.autonomousTurns,
    maxTurns: input.maxTurns,
    lastStatus: input.lastSendResult.status,
    dispatchesThisTurn: input.dispatchesThisTurn,
    runningWorkers: input.workerSession.runtime.runningCount,
    pendingPermissions: input.permissionPipeline.pending.size,
    openQuestions: input.openQuestions.openCount,
    continueOnConductorError: input.continueOnConductorError,
    stopOnUnansweredInput: input.stopOnUnansweredInput,
  };
}
