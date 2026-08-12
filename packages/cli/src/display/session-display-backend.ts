import type { SessionLogEvent } from '@agents-ensemble/core';
import type { SessionDisplayState } from './session-display-state.js';

/** 表示 state を出力先へ反映する。harness テレメトリは state 外で別 sink が担当する。 */
export interface SessionDisplayBackend {
  render(
    state: SessionDisplayState,
    previousState: SessionDisplayState,
    event: SessionLogEvent,
  ): void;
}
