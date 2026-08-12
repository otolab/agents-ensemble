import type { OperatorInputContext } from '@agents-ensemble/core';
import type { SessionDisplayState } from '../display/session-display-state.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import {
  appendActivityLogEntry,
  type ActivityLogEntry,
  type ActivityLogLabel,
} from './activity-log.js';

export interface TuiViewSnapshot {
  displayState: SessionDisplayState;
  activityLog: ActivityLogEntry[];
  postLoopWaiting: boolean;
  operatorContext: OperatorInputContext | undefined;
}

export interface TuiViewModel {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TuiViewSnapshot;
  setDisplayState: (state: SessionDisplayState) => void;
  appendActivityLog: (label: ActivityLogLabel, text: string) => void;
  setPostLoopWaiting: (waiting: boolean) => void;
  setOperatorContext: (context: OperatorInputContext | undefined) => void;
}

export function createTuiViewModel(): TuiViewModel {
  let displayState = INITIAL_SESSION_DISPLAY_STATE;
  let activityLog: ActivityLogEntry[] = [];
  let postLoopWaiting = false;
  let operatorContext: OperatorInputContext | undefined;
  let snapshot: TuiViewSnapshot = {
    displayState,
    activityLog,
    postLoopWaiting,
    operatorContext,
  };
  const listeners = new Set<() => void>();

  const rebuildSnapshot = () => {
    snapshot = {
      displayState,
      activityLog,
      postLoopWaiting,
      operatorContext,
    };
  };

  const notify = () => {
    rebuildSnapshot();
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    setDisplayState(state) {
      displayState = state;
      notify();
    },
    appendActivityLog(label, text) {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      activityLog = appendActivityLogEntry(activityLog, { label, text: trimmed });
      notify();
    },
    setPostLoopWaiting(waiting) {
      if (postLoopWaiting === waiting) {
        return;
      }
      postLoopWaiting = waiting;
      notify();
    },
    setOperatorContext(context) {
      operatorContext = context;
      notify();
    },
  };
}
