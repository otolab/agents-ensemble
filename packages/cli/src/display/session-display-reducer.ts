import type { SessionLogEvent } from '@agents-ensemble/core';
import {
  INITIAL_SESSION_DISPLAY_STATE,
  type SessionDisplayState,
  type WorkerDisplayStatus,
} from './session-display-state.js';

function setWorkerStatus(
  state: SessionDisplayState,
  name: string,
  kind: string,
  status: WorkerDisplayStatus,
): SessionDisplayState {
  const current = state.workers[name];
  if (current?.kind === kind && current.status === status) {
    return state;
  }

  return {
    ...state,
    workers: {
      ...state.workers,
      [name]: { kind, status },
    },
  };
}

function formatConductorErrorMessage(message: string): string {
  return `応答を生成できませんでした（${message}）。\n別の聞き方で再入力してください。`;
}

/** `SessionLogEvent` から表示 state を純関数で更新する。 */
export function reduceDisplayState(
  state: SessionDisplayState,
  event: SessionLogEvent,
): SessionDisplayState {
  switch (event.type) {
    case 'harness.worker.bootstrap.started':
      return setWorkerStatus(state, event.name, event.kind, 'running');
    case 'harness.worker.bootstrap.completed':
      return setWorkerStatus(state, event.name, event.kind, 'idle');
    case 'harness.worker.bootstrap.failed':
      return setWorkerStatus(state, event.name, event.kind, 'failed');
    case 'worker.round':
      return setWorkerStatus(
        state,
        event.dispatch.name,
        event.dispatch.kind,
        'idle',
      );
    case 'worker.failed':
      return setWorkerStatus(
        state,
        event.failure.name,
        event.failure.kind,
        'failed',
      );
    case 'conductor.send': {
      if (event.status === 'finished' && event.result?.trim()) {
        const output = event.result.trim();
        if (state.conductorOutput === output) {
          return state;
        }
        return { ...state, conductorOutput: output };
      }
      if (event.status === 'error') {
        const detail = event.error?.message ?? 'unknown error';
        const output = formatConductorErrorMessage(detail);
        if (state.conductorOutput === output) {
          return state;
        }
        return { ...state, conductorOutput: output };
      }
      return state;
    }
    case 'open.question.enqueued': {
      if (event.question.status !== 'open') {
        return state;
      }
      if (state.openQuestions.some((question) => question.id === event.question.id)) {
        return state;
      }
      return {
        ...state,
        openQuestions: [...state.openQuestions, event.question],
      };
    }
    case 'escalation.recorded':
      return {
        ...state,
        openQuestions: state.openQuestions.filter(
          (question) => question.question !== event.record.question,
        ),
      };
    default:
      return state;
  }
}

export { INITIAL_SESSION_DISPLAY_STATE };
