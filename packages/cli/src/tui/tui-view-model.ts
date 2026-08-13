import type { OperatorInputContext } from '@agents-ensemble/core';
import type { SessionDisplayState } from '../display/session-display-state.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import {
  appendActivityLogEntry,
  type ActivityLogEntry,
  type ActivityLogLabel,
} from './activity-log.js';
import { trimBlankLinesOnly } from './operator-input-layout.js';

export interface TuiViewSnapshot {
  displayState: SessionDisplayState;
  activityLog: ActivityLogEntry[];
  postLoopWaiting: boolean;
  shuttingDown: boolean;
  operatorContext: OperatorInputContext | undefined;
}

export interface TuiViewModel {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TuiViewSnapshot;
  setDisplayState: (state: SessionDisplayState) => void;
  appendActivityLog: (label: ActivityLogLabel, text: string) => void;
  appendActivityLogSeparator: () => void;
  setPostLoopWaiting: (waiting: boolean) => void;
  setShuttingDown: (shuttingDown: boolean) => void;
  setOperatorContext: (context: OperatorInputContext | undefined) => void;
}

export function createTuiViewModel(): TuiViewModel {
  let displayState = INITIAL_SESSION_DISPLAY_STATE;
  let activityLog: ActivityLogEntry[] = [];
  let postLoopWaiting = false;
  let shuttingDown = false;
  let operatorContext: OperatorInputContext | undefined;
  let snapshot: TuiViewSnapshot = {
    displayState,
    activityLog,
    postLoopWaiting,
    shuttingDown,
    operatorContext,
  };
  const listeners = new Set<() => void>();

  const rebuildSnapshot = () => {
    snapshot = {
      displayState,
      activityLog,
      postLoopWaiting,
      shuttingDown,
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
      const trimmed = trimBlankLinesOnly(text);
      if (!trimmed) {
        return;
      }
      activityLog = appendActivityLogEntry(activityLog, { label, text: trimmed });
      notify();
    },
    appendActivityLogSeparator() {
      activityLog = appendActivityLogEntry(activityLog, { label: 'separator', text: '' });
      notify();
    },
    setPostLoopWaiting(waiting) {
      if (postLoopWaiting === waiting) {
        return;
      }
      postLoopWaiting = waiting;
      notify();
    },
    setShuttingDown(next) {
      if (shuttingDown === next) {
        return;
      }
      shuttingDown = next;
      notify();
    },
    setOperatorContext(context) {
      operatorContext = context;
      notify();
    },
  };
}
