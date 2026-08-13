import {
  mapHarnessToDisplayStatus,
  type SessionLogEvent,
} from '@agents-ensemble/core';
import {
  INITIAL_SESSION_DISPLAY_STATE,
  type SessionDisplayState,
  type WorkerDisplayStatus,
} from './session-display-state.js';

const WORKER_RUNNING = mapHarnessToDisplayStatus('processing');
const WORKER_IDLE = mapHarnessToDisplayStatus('idle');
const WORKER_FAILED = mapHarnessToDisplayStatus('failed');

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

function seedSessionWorkers(
  state: SessionDisplayState,
  workers: Array<{ name: string; kind: string }>,
): SessionDisplayState {
  let next = state;
  for (const worker of workers) {
    if (next.workers[worker.name]) {
      continue;
    }
    next = setWorkerStatus(next, worker.name, worker.kind, WORKER_IDLE);
  }
  return next;
}

/** `SessionLogEvent` から表示 state を純関数で更新する。 */
export function reduceDisplayState(
  state: SessionDisplayState,
  event: SessionLogEvent,
): SessionDisplayState {
  switch (event.type) {
    case 'harness.session.workers':
      return seedSessionWorkers(state, event.workers);
    case 'harness.worker.state':
      return setWorkerStatus(
        state,
        event.name,
        event.kind,
        mapHarnessToDisplayStatus(event.state),
      );
    case 'harness.worker.prompt.started':
      return setWorkerStatus(state, event.name, event.kind, WORKER_RUNNING);
    case 'harness.worker.prompt.completed':
      return setWorkerStatus(state, event.name, event.kind, WORKER_IDLE);
    case 'harness.worker.prompt.failed':
      return setWorkerStatus(state, event.name, event.kind, WORKER_FAILED);
    case 'harness.worker.acp.update':
      return setWorkerStatus(state, event.name, event.kind, WORKER_RUNNING);
    case 'conductor.send.started':
      return setWorkerStatus(state, 'conductor', 'conductor', 'running');
    case 'worker.round': {
      const { name, kind, source } = event.dispatch;
      const current = state.workers[name];
      if (source === 'harness') {
        return state;
      }
      if (current?.status === 'running') {
        return setWorkerStatus(state, name, kind, WORKER_IDLE);
      }
      if (!current && source === 'conductor') {
        return setWorkerStatus(state, name, kind, WORKER_IDLE);
      }
      return state;
    }
    case 'worker.failed':
      return setWorkerStatus(
        state,
        event.failure.name,
        event.failure.kind,
        WORKER_FAILED,
      );
    case 'conductor.send': {
      let nextState = setWorkerStatus(state, 'conductor', 'conductor', 'idle');
      if (event.status === 'finished' && event.result?.trim()) {
        const output = event.result.trim();
        if (nextState.conductorOutput === output) {
          return nextState;
        }
        return { ...nextState, conductorOutput: output };
      }
      if (event.status === 'error') {
        const detail = event.error?.message ?? 'unknown error';
        const output = formatConductorErrorMessage(detail);
        if (nextState.conductorOutput === output) {
          return nextState;
        }
        return { ...nextState, conductorOutput: output };
      }
      return nextState;
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
