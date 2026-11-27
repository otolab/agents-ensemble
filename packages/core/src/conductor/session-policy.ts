import type { ConductorSendResult } from './conductor-agent.js';
import type { SessionEvent } from './session/session-event.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { WorkerSession } from '../runtime/worker-session.js';
import {
  createConductorCoreState,
  isMaxTurnsLimitedCore,
  stepConductorCore,
  type ConductorCoreDispatchBatchState,
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
  const transition = stepConductorCore(
    createConductorCoreState({ issueLoop: input }),
    { type: 'issueLoop.stopCheck' },
  );
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
  const transition = stepConductorCore(
    createConductorCoreState({ issueLoop: input }),
    { type: 'issueLoop.stopCheck' },
  );
  const decision = transition.effects.find(
    (effect) =>
      effect.kind === 'action' && effect.action.type === 'issueLoopStop',
  );
  return decision?.kind === 'action' &&
    decision.action.type === 'issueLoopStop'
    ? decision.action.stopReason
    : 'completed';
}

export interface IssueLoopDriverDecisionInput extends IssueLoopStopInput {
  queue: readonly SessionEvent[];
  dispatchHold: boolean;
  heldEvents: readonly SessionEvent[];
  dispatchBatchState: ConductorCoreDispatchBatchState;
  recoveryConfirmationRequired: boolean;
  operatorCanInspectRecovery: boolean;
  continueAfterIssueLoopStop: boolean;
  workerInboxDrained?: boolean;
  postLoopWaiting: boolean;
  idleOperatorMessageReady?: boolean;
}

export interface IssueLoopDriverDecision {
  decision: 'stop' | 'continue' | 'drainWorkerInbox';
  stopReason: IssueLoopStopReason;
  notifyIssueLoopStop: boolean;
  postLoopWaiting: boolean;
  idleOperatorMessageReady?: boolean;
}

/** Driver の停止優先・待機・inbox drain 要否を core に委ねる。 */
export function decideIssueLoopDriver(
  input: IssueLoopDriverDecisionInput,
): IssueLoopDriverDecision {
  const transition = stepConductorCore(
    createConductorCoreState({
      issueLoop: input,
      queue: [...input.queue],
      dispatchHold: input.dispatchHold,
      heldEvents: [...input.heldEvents],
      dispatchBatchState: input.dispatchBatchState,
      autonomousTurns: input.autonomousTurns,
      recoveryConfirmationRequired: input.recoveryConfirmationRequired,
      operatorCanInspectRecovery: input.operatorCanInspectRecovery,
      continueAfterIssueLoopStop: input.continueAfterIssueLoopStop,
      workerInboxDrained: input.workerInboxDrained ?? false,
      postLoopWaiting: input.postLoopWaiting,
      ...(input.idleOperatorMessageReady === undefined
        ? {}
        : { idleOperatorMessageReady: input.idleOperatorMessageReady }),
    }),
    { type: 'issueLoop.driverStopCheck' },
  );
  const decision = transition.effects.find(
    (effect) =>
      effect.kind === 'action' && effect.action.type === 'issueLoopDecision',
  );
  if (
    decision?.kind !== 'action' ||
    decision.action.type !== 'issueLoopDecision'
  ) {
    return {
      decision: 'continue',
      stopReason: 'completed',
      notifyIssueLoopStop: false,
      postLoopWaiting: transition.state.postLoopWaiting,
      ...(transition.state.idleOperatorMessageReady === undefined
        ? {}
        : {
            idleOperatorMessageReady:
              transition.state.idleOperatorMessageReady,
          }),
    };
  }
  return {
    decision: decision.action.decision,
    stopReason: decision.action.stopReason,
    notifyIssueLoopStop: decision.action.notifyIssueLoopStop === true,
    postLoopWaiting: transition.state.postLoopWaiting,
    ...(transition.state.idleOperatorMessageReady === undefined
      ? {}
      : {
          idleOperatorMessageReady:
            transition.state.idleOperatorMessageReady,
        }),
  };
}

export function recoveryConfirmationStopReason(input: {
  lastStatus: string;
  confirmationRequired: boolean;
  operatorCanInspectRecovery: boolean;
}): IssueLoopStopReason | undefined {
  const transition = stepConductorCore(
    createConductorCoreState({
      issueLoop: {
        autonomousTurns: 0,
        maxTurns: 0,
        lastStatus: input.lastStatus,
        dispatchesThisTurn: 0,
      },
      recoveryConfirmationRequired: input.confirmationRequired,
      operatorCanInspectRecovery: input.operatorCanInspectRecovery,
    }),
    { type: 'issueLoop.confirmationGate' },
  );
  const decision = transition.effects.find(
    (effect) =>
      effect.kind === 'action' &&
      effect.action.type === 'issueLoopConfirmationGate',
  );
  return decision?.kind === 'action' &&
    decision.action.type === 'issueLoopConfirmationGate' &&
    decision.action.shouldStop
    ? decision.action.stopReason
    : undefined;
}

export function allowIdleOperatorMessages(input: {
  queue: readonly SessionEvent[];
  dispatchHold: boolean;
  heldEvents: readonly SessionEvent[];
  dispatchBatchState: ConductorCoreDispatchBatchState;
  autonomousTurns: number;
  maxTurns: number;
  runningWorkers: number;
}): boolean {
  const transition = stepConductorCore(
    createConductorCoreState({
      issueLoop: {
        autonomousTurns: input.autonomousTurns,
        maxTurns: input.maxTurns,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        runningWorkers: input.runningWorkers,
      },
      queue: [...input.queue],
      dispatchHold: input.dispatchHold,
      heldEvents: [...input.heldEvents],
      dispatchBatchState: input.dispatchBatchState,
      autonomousTurns: input.autonomousTurns,
    }),
    { type: 'dispatch.idleOperatorMessageGate' },
  );
  const decision = transition.effects.find(
    (effect) =>
      effect.kind === 'action' &&
      effect.action.type === 'idleOperatorMessageGate',
  );
  return (
    decision?.kind === 'action' &&
    decision.action.type === 'idleOperatorMessageGate' &&
    decision.action.allowed
  );
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
