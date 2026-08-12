import { describe, expect, it } from 'vitest';
import {
  INITIAL_SESSION_DISPLAY_STATE,
  reduceDisplayState,
} from './session-display-reducer.js';

const TEST_DISPATCH = {
  name: 'implementer',
  kind: 'implementer',
  issue: {
    owner: 'o',
    repo: 'r',
    number: 1,
    url: 'https://github.com/o/r/issues/1',
  },
  worktree: {
    path: '/wt',
    branch: 'b',
    issue: {
      owner: 'o',
      repo: 'r',
      number: 1,
      url: 'https://github.com/o/r/issues/1',
    },
  },
  prompt: 'p',
  promptResult: { stopReason: 'end_turn', responseText: 'done' },
  acpSessionId: 's',
} as const;

const OPEN_QUESTION = {
  id: 'inq-1',
  question: 'approve merge?',
  responseType: 'yes_no' as const,
  source: 'conductor' as const,
  status: 'open' as const,
  askedAt: 1,
};

describe('reduceDisplayState', () => {
  it('tracks worker bootstrap lifecycle as running then idle', () => {
    let state = INITIAL_SESSION_DISPLAY_STATE;

    state = reduceDisplayState(state, {
      type: 'harness.worker.bootstrap.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
    });
    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'running',
    });

    state = reduceDisplayState(state, {
      type: 'harness.worker.bootstrap.completed',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      stopReason: 'end_turn',
    });
    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'idle',
    });
  });

  it('marks worker failed on bootstrap failure', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.worker.bootstrap.failed',
      name: 'reviewer',
      kind: 'reviewer',
      workerId: 'w-2',
      error: 'attach failed',
    });

    expect(state.workers.reviewer).toEqual({
      kind: 'reviewer',
      status: 'failed',
    });
  });

  it('sets worker idle after instruction round without running state', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'worker.round',
      dispatch: { ...TEST_DISPATCH, roundKind: 'instruction' },
    });

    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'idle',
    });
  });

  it('marks worker failed on worker.failed', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'worker.failed',
      failure: {
        workerId: 'w-1',
        name: 'implementer',
        kind: 'implementer',
        error: 'prompt failed',
        issueUrl: 'https://github.com/o/r/issues/1',
      },
    });

    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'failed',
    });
  });

  it('updates conductorOutput on finished conductor.send', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: '  hello conductor  ',
      workerDispatches: 0,
      workerFailures: 0,
    });

    expect(state.conductorOutput).toBe('hello conductor');
  });

  it('updates conductorOutput on error conductor.send', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'error',
      error: { message: 'Model Blocked' },
      workerDispatches: 0,
      workerFailures: 0,
    });

    expect(state.conductorOutput).toBe(
      '応答を生成できませんでした（Model Blocked）。\n別の聞き方で再入力してください。',
    );
  });

  it('tracks open questions via open.question.enqueued', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'open.question.enqueued',
      question: OPEN_QUESTION,
    });

    expect(state.openQuestions).toEqual([OPEN_QUESTION]);
  });

  it('removes answered open question on escalation.recorded', () => {
    const withQuestion = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'open.question.enqueued',
      question: OPEN_QUESTION,
    });

    const state = reduceDisplayState(withQuestion, {
      type: 'escalation.recorded',
      record: {
        question: 'approve merge?',
        responseType: 'yes_no',
        answer: 'yes',
      },
    });

    expect(state.openQuestions).toEqual([]);
  });

  it('ignores harness events outside display state', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.worktree',
      path: '/wt',
      branch: 'b',
      mode: 'isolated',
    });

    expect(state).toBe(INITIAL_SESSION_DISPLAY_STATE);
  });

  it('covers four-pane state in one session flow', () => {
    let state = INITIAL_SESSION_DISPLAY_STATE;

    state = reduceDisplayState(state, {
      type: 'harness.worker.bootstrap.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
    });
    state = reduceDisplayState(state, {
      type: 'harness.worker.bootstrap.completed',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      stopReason: 'end_turn',
    });
    state = reduceDisplayState(state, {
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: 'proceed',
      workerDispatches: 0,
      workerFailures: 0,
    });
    state = reduceDisplayState(state, {
      type: 'open.question.enqueued',
      question: OPEN_QUESTION,
    });
    state = reduceDisplayState(state, {
      type: 'worker.round',
      dispatch: TEST_DISPATCH,
    });

    expect(state.workers.implementer?.status).toBe('idle');
    expect(state.conductorOutput).toBe('proceed');
    expect(state.openQuestions).toHaveLength(1);
  });
});
