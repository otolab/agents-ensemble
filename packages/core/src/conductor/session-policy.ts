import type { ConductorSendResult } from './conductor-agent.js';
import type { SessionEvent } from './session/session-event.js';
import { isConductorSendEvent } from './session/session-event.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { WorkerSession } from '../runtime/worker-session.js';

export type IssueLoopStopReason =
  | 'completed'
  | 'error'
  | 'max_turns'
  | 'interrupted';

export interface IssueLoopStopInput {
  /** 直近のオペレータ入力から消費した conductor 自律ターン数。 */
  autonomousTurns: number;
  maxTurns: number;
  lastStatus: string;
  dispatchesThisTurn: number;
  runningWorkers?: number;
  pendingPermissions?: number;
  openQuestions?: number;
  /** TTY 等でオペレータ入力があるとき、conductor error でもループを継続する。 */
  continueOnConductorError?: boolean;
}

export const DEFAULT_MAX_ISSUE_TURNS = 5;

/** Issue session の conductor ループを終了すべきか判定する。 */
export function shouldStopIssueLoop(input: IssueLoopStopInput): boolean {
  if (input.lastStatus === 'error') {
    return !input.continueOnConductorError;
  }
  if ((input.runningWorkers ?? 0) > 0) return false;
  if ((input.pendingPermissions ?? 0) > 0) return false;
  if ((input.openQuestions ?? 0) > 0) return false;
  if (input.dispatchesThisTurn === 0 && input.lastStatus === 'finished') {
    return true;
  }
  return false;
}

export function resolveIssueLoopStopReason(
  input: IssueLoopStopInput,
): IssueLoopStopReason {
  if (input.lastStatus === 'error') return 'error';
  return 'completed';
}

/** 自律ターン上限到達後も conductor へ送れるイベントか。 */
export function canDispatchConductorSend(
  event: SessionEvent,
  autonomousTurns: number,
  maxTurns: number,
): boolean {
  if (!isConductorSendEvent(event)) {
    return false;
  }
  if (event.type === 'operator.message' || event.type === 'permission.pending') {
    return true;
  }
  return autonomousTurns < maxTurns;
}

/** conductor send 完了後の `autonomousTurns`（オペレータ入力でリセット）。 */
export function autonomousTurnsAfterConductorSend(
  event: SessionEvent,
  autonomousTurns: number,
): number {
  if (event.type === 'operator.message') {
    return 0;
  }
  return autonomousTurns + 1;
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
  };
}
