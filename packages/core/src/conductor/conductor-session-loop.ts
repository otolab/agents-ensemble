import type { SessionEvent } from './session/session-event.js';
import { isConductorSendEvent } from './session/session-event.js';

/**
 * ConductorSession ループの dispatch ポリシー。
 * CLI / 将来の TUI は `bindOperatorInput` でキューへ積むだけとし、
 * 「いま送れるか」「送信後の自律ターン」はここを正本とする。
 */

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
