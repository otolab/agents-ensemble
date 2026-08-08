export type IssueLoopStopReason = 'completed' | 'error' | 'max_turns';

export interface IssueLoopStopInput {
  turn: number;
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
  if (input.turn >= input.maxTurns) return true;
  if (input.dispatchesThisTurn === 0 && input.lastStatus === 'finished') {
    return true;
  }
  return false;
}

export function resolveIssueLoopStopReason(
  input: IssueLoopStopInput,
): IssueLoopStopReason {
  if (input.lastStatus === 'error') return 'error';
  if (input.turn >= input.maxTurns) return 'max_turns';
  return 'completed';
}

export const DEFAULT_MAX_ISSUE_TURNS = 5;
