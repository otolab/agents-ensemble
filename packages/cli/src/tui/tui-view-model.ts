import type { OperatorInputContext } from '@agents-ensemble/core';
import type { SessionDisplayState } from '../display/session-display-state.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import {
  ACTIVITY_LOG_WINDOW_SIZE,
  appendActivityLogEntry,
  type ActivityLogEntry,
  type ActivityLogLabel,
} from './activity-log.js';
import { trimBlankLinesOnly } from './operator-input-layout.js';

export interface TuiViewSnapshot {
  displayState: SessionDisplayState;
  activityLog: ActivityLogEntry[];
  activityLogGeneration: number;
  postLoopWaiting: boolean;
  shuttingDown: boolean;
  operatorContext: OperatorInputContext | undefined;
}

/**
 * TUI が使う未回答 open question の正本を解決する。
 *
 * `operatorContext` は `OpenQuestionRegistry.listOpen()` のスナップショットで、
 * resume 時にも binding の初期化で設定される。binding 前の描画だけは、イベント
 * reducer が保持する display state をフォールバックとして使う。
 */
export function getTuiOpenQuestions(
  snapshot: TuiViewSnapshot,
): TuiViewSnapshot['displayState']['openQuestions'] {
  return snapshot.operatorContext?.openQuestions ?? snapshot.displayState.openQuestions;
}

function sameOperatorContext(
  left: OperatorInputContext | undefined,
  right: OperatorInputContext | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (
    !left ||
    !right ||
    left.conductorTurn !== right.conductorTurn ||
    left.autonomousTurns !== right.autonomousTurns ||
    left.maxTurns !== right.maxTurns ||
    left.openQuestions.length !== right.openQuestions.length
  ) {
    return false;
  }

  for (let index = 0; index < left.openQuestions.length; index += 1) {
    if (left.openQuestions[index] !== right.openQuestions[index]) {
      return false;
    }
  }

  const leftQueue = left.queuedMessages ?? [];
  const rightQueue = right.queuedMessages ?? [];
  if (leftQueue.length !== rightQueue.length) {
    return false;
  }
  for (let index = 0; index < leftQueue.length; index += 1) {
    const leftMessage = leftQueue[index];
    const rightMessage = rightQueue[index];
    if (
      !leftMessage ||
      !rightMessage ||
      leftMessage.text !== rightMessage.text ||
      leftMessage.delivery !== rightMessage.delivery ||
      leftMessage.openQuestionAnswer !== rightMessage.openQuestionAnswer ||
      leftMessage.answerPreview !== rightMessage.answerPreview
    ) {
      return false;
    }
  }

  return true;
}

export interface TuiViewModel {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TuiViewSnapshot;
  setDisplayState: (state: SessionDisplayState) => void;
  appendActivityLog: (label: ActivityLogLabel, text: string) => void;
  appendActivityLogSeparator: () => void;
  requestActivityLogReplay: () => void;
  setPostLoopWaiting: (waiting: boolean) => void;
  setShuttingDown: (shuttingDown: boolean) => void;
  setOperatorContext: (context: OperatorInputContext | undefined) => void;
}

export function createTuiViewModel(options: {
  /** `null` keeps every entry so Ink's `<Static>` can append monotonically. */
  activityLogWindowSize?: number | null;
} = {}): TuiViewModel {
  const activityLogWindowSize =
    options.activityLogWindowSize === undefined
      ? ACTIVITY_LOG_WINDOW_SIZE
      : options.activityLogWindowSize;
  let displayState = INITIAL_SESSION_DISPLAY_STATE;
  let activityLog: ActivityLogEntry[] = [];
  let activityLogGeneration = 0;
  let postLoopWaiting = false;
  let shuttingDown = false;
  let operatorContext: OperatorInputContext | undefined;
  let snapshot: TuiViewSnapshot = {
    displayState,
    activityLog,
    activityLogGeneration,
    postLoopWaiting,
    shuttingDown,
    operatorContext,
  };
  const listeners = new Set<() => void>();

  const rebuildSnapshot = () => {
    snapshot = {
      displayState,
      activityLog,
      activityLogGeneration,
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
      const entry = { label, text: trimmed } satisfies ActivityLogEntry;
      activityLog = appendActivityLogEntry(
        activityLog,
        entry,
        activityLogWindowSize,
      );
      notify();
    },
    appendActivityLogSeparator() {
      const entry = { label: 'separator', text: '' } satisfies ActivityLogEntry;
      activityLog = appendActivityLogEntry(
        activityLog,
        entry,
        activityLogWindowSize,
      );
      notify();
    },
    requestActivityLogReplay() {
      activityLogGeneration += 1;
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
      // getContext() rebuilds list and queue arrays for every session event.
      if (sameOperatorContext(operatorContext, context)) {
        return;
      }
      operatorContext = context;
      notify();
    },
  };
}
