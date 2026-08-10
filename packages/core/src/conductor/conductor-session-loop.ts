import type { SessionEvent } from './session/session-event.js';
import { isConductorSendEvent } from './session/session-event.js';

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
