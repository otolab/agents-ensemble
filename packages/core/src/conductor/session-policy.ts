import type { ConductorSendResult } from './conductor-agent.js';
import type { SessionEvent } from './session/session-event.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { WorkerSession } from '../runtime/worker-session.js';

export type IssueLoopStopReason =
  | 'completed'
  | 'error'
  | 'cancelled'
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
  /** 初回入力だけで終了する経路では、追加の operator 入力を待たずに停止する。 */
  stopOnUnansweredInput?: boolean;
}

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
  return maxTurns > 0;
}

/** View 向けの `maxTurns`（無制限時は `null`）。 */
export function operatorInputMaxTurns(maxTurns: number): number | null {
  return isMaxTurnsLimited(maxTurns) ? maxTurns : null;
}

/** Issue session の conductor 自律ループを終了すべきか判定する（プロセス終了ではない）。 */
export function shouldStopIssueLoop(input: IssueLoopStopInput): boolean {
  // `cancelled` is a terminal SDK run status, not a retryable conductor error.
  // In particular, one-shot sessions must not fall through to event waiting.
  if (input.lastStatus === 'cancelled') {
    return true;
  }
  if (input.lastStatus === 'error') {
    return !input.continueOnConductorError;
  }
  if (
    input.stopOnUnansweredInput &&
    ((input.pendingPermissions ?? 0) > 0 || (input.openQuestions ?? 0) > 0)
  ) {
    return true;
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
  if (input.lastStatus === 'cancelled') return 'cancelled';
  if (input.lastStatus === 'error') return 'error';
  return 'completed';
}

/** 自律ターン上限到達後も conductor へ送れるイベントか。 */
export function canDispatchConductorSend(
  event: SessionEvent,
  autonomousTurns: number,
  maxTurns: number,
): boolean {
  if (event.type === 'operator.message' || event.type === 'permission.pending') {
    return true;
  }
  if (!isMaxTurnsLimited(maxTurns)) {
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

/** 束 dispatch 後の `autonomousTurns`（束に operator が含まれればリセット）。 */
export function autonomousTurnsAfterConductorBatch(
  events: SessionEvent[],
  autonomousTurns: number,
): number {
  if (events.some((event) => event.type === 'operator.message')) {
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
