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
}

/** Issue session の conductor ループを終了すべきか判定する。 */
export function shouldStopIssueLoop(input: IssueLoopStopInput): boolean {
  if (input.lastStatus === 'error') return true;
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

export const DEFAULT_MAX_ISSUE_TURNS = 5;
