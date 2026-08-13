import type { SessionEvent } from './session-event.js';

/**
 * harness イベントの conductor dispatch モード（#148）。
 * - telemetry: SessionLogEvent のみ（本モジュールの対象外）
 * - inform: 次の trigger 束に同梱（フェーズ2）
 * - trigger: 単独で `agent.send` 束の主体になりうる（現行 SessionEvent）
 */
export type DispatchMode = 'telemetry' | 'inform' | 'trigger';

export const DEFAULT_SESSION_EVENT_DISPATCH_MODE: DispatchMode = 'trigger';

/** SessionEvent に載せる optional `dispatchMode` の読み取り。 */
export function sessionEventDispatchMode(event: SessionEvent): DispatchMode {
  if ('dispatchMode' in event && event.dispatchMode) {
    return event.dispatchMode;
  }
  return DEFAULT_SESSION_EVENT_DISPATCH_MODE;
}

/** 単独で conductor dispatch 束の主体になりうるか。 */
export function canTriggerConductorDispatch(mode: DispatchMode): boolean {
  return mode === 'trigger';
}

/** `selectDispatchBatch` の eligible 判定用。inform は単独束にならない。 */
export function isTriggerSessionEvent(event: SessionEvent): boolean {
  return canTriggerConductorDispatch(sessionEventDispatchMode(event));
}
