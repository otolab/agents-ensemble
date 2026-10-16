import {
  mapHarnessToDisplayStatus,
  type SessionLogEvent,
} from '@agents-ensemble/core';
import {
  INITIAL_SESSION_DISPLAY_STATE,
  type SessionDisplayState,
  type WorkerDisplayStatus,
} from './session-display-state.js';
import { conductorActivityFromSendProgress } from './conductor-activity-from-send-progress.js';
import { workerActivityFromAcpUpdate } from './worker-activity-from-acp-update.js';

const WORKER_RUNNING = mapHarnessToDisplayStatus('processing');
const WORKER_IDLE = mapHarnessToDisplayStatus('idle');

function setWorkerStatus(
  state: SessionDisplayState,
  name: string,
  kind: string,
  status: WorkerDisplayStatus,
  activity?: string,
): SessionDisplayState {
  const nextActivity = status === 'running' ? activity : undefined;
  const current = state.workers[name];
  if (
    current?.kind === kind &&
    current.status === status &&
    current.activity === nextActivity
  ) {
    return state;
  }

  const worker = { kind, status, ...(nextActivity ? { activity: nextActivity } : {}) };

  return {
    ...state,
    workers: {
      ...state.workers,
      [name]: worker,
    },
  };
}

function seedSessionWorkers(
  state: SessionDisplayState,
  workers: Array<{ name: string; kind: string }>,
  initialState: 'idle' | 'sleeping' = 'idle',
): SessionDisplayState {
  let next = state;
  const status =
    initialState === 'sleeping'
      ? mapHarnessToDisplayStatus('sleeping')
      : WORKER_IDLE;
  for (const worker of workers) {
    if (next.workers[worker.name]) {
      continue;
    }
    next = setWorkerStatus(next, worker.name, worker.kind, status);
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
      return seedSessionWorkers(state, event.workers, event.initialState);
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
      // Failure telemetry is diagnostic only. The associated lifecycle state
      // event owns status and may precede or follow this event.
      return state;
    case 'harness.worker.acp.update': {
      const activity = workerActivityFromAcpUpdate(
        event.sessionUpdate,
        event.toolName,
      );
      if (!activity) {
        return state;
      }
      return setWorkerStatus(state, event.name, event.kind, WORKER_RUNNING, activity);
    }
    case 'conductor.send.started':
      return setWorkerStatus(state, 'conductor', 'conductor', 'running');
    case 'conductor.send.progress': {
      const activity = conductorActivityFromSendProgress(event.tool);
      return setWorkerStatus(state, 'conductor', 'conductor', 'running', activity);
    }
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
      // This inbox notification is asynchronous and may arrive after a newer
      // idle/processing state. Terminal failures are represented by
      // harness.worker.state, so do not project this notification as status.
      return state;
    case 'conductor.send': {
      let nextState = setWorkerStatus(state, 'conductor', 'conductor', 'idle');
      if (event.status === 'finished' && event.result?.trim()) {
        const output = event.result.trim();
        if (nextState.conductorOutput === output) {
          return nextState;
        }
        return { ...nextState, conductorOutput: output };
      }
      return nextState;
    }
    case 'conductor.dispatch_hold': {
      const dispatchHold = {
        hold: event.hold,
        heldEventCount: event.heldEventCount,
      };
      if (
        state.dispatchHold.hold === dispatchHold.hold &&
        state.dispatchHold.heldEventCount === dispatchHold.heldEventCount
      ) {
        return state;
      }
      return { ...state, dispatchHold };
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
