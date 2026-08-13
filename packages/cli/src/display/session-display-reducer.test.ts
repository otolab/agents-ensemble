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
  it('tracks worker prompt lifecycle as running then idle', () => {
    let state = INITIAL_SESSION_DISPLAY_STATE;

    state = reduceDisplayState(state, {
      type: 'harness.worker.prompt.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'harness',
    });
    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'running',
    });

    state = reduceDisplayState(state, {
      type: 'harness.worker.prompt.completed',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'harness',
      stopReason: 'end_turn',
    });
    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'idle',
    });
  });

  it('marks worker failed on prompt failure', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.worker.prompt.failed',
      name: 'reviewer',
      kind: 'reviewer',
      workerId: 'w-2',
      source: 'harness',
      error: 'attach failed',
    });

    expect(state.workers.reviewer).toEqual({
      kind: 'reviewer',
      status: 'failed',
    });
  });

  it('tracks conductor-sourced prompt as running then idle', () => {
    let state = INITIAL_SESSION_DISPLAY_STATE;

    state = reduceDisplayState(state, {
      type: 'harness.worker.prompt.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'conductor',
    });
    expect(state.workers.implementer?.status).toBe('running');

    state = reduceDisplayState(state, {
      type: 'harness.worker.prompt.completed',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'conductor',
      stopReason: 'end_turn',
    });
    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'idle',
    });
  });

  it('seeds profile workers as idle on harness.session.workers', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.session.workers',
      workers: [
        { name: 'implementer', kind: 'implementer' },
        { name: 'reviewer', kind: 'reviewer' },
      ],
    });

    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'idle',
    });
    expect(state.workers.reviewer).toEqual({
      kind: 'reviewer',
      status: 'idle',
    });
  });

  it('maps harness.worker.state attaching and processing to running', () => {
    let state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.session.workers',
      workers: [{ name: 'implementer', kind: 'implementer' }],
    });

    state = reduceDisplayState(state, {
      type: 'harness.worker.state',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      state: 'attaching',
    });
    expect(state.workers.implementer?.status).toBe('running');

    state = reduceDisplayState(state, {
      type: 'harness.worker.state',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      state: 'processing',
    });
    expect(state.workers.implementer?.status).toBe('running');

    state = reduceDisplayState(state, {
      type: 'harness.worker.state',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      state: 'idle',
    });
    expect(state.workers.implementer?.status).toBe('idle');
  });

  it('does not force idle on harness worker.round when worker is not running', () => {
    const seeded = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.session.workers',
      workers: [{ name: 'implementer', kind: 'implementer' }],
    });
    const processing = reduceDisplayState(seeded, {
      type: 'harness.worker.state',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      state: 'processing',
    });

    const state = reduceDisplayState(processing, {
      type: 'worker.round',
      dispatch: { ...TEST_DISPATCH, source: 'harness' },
    });

    expect(state.workers.implementer?.status).toBe('running');
  });

  it('keeps running across preempt cancel without completed', () => {
    let state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.session.workers',
      workers: [{ name: 'implementer', kind: 'implementer' }],
    });
    state = reduceDisplayState(state, {
      type: 'harness.worker.prompt.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'conductor',
    });
    state = reduceDisplayState(state, {
      type: 'harness.worker.state',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      state: 'processing',
    });
    state = reduceDisplayState(state, {
      type: 'harness.worker.prompt.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'conductor',
    });

    expect(state.workers.implementer?.status).toBe('running');
  });

  it('sets worker idle after instruction round via worker.round fallback', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'worker.round',
      dispatch: { ...TEST_DISPATCH, source: 'conductor' },
    });

    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'idle',
    });
  });

  it('sets worker running on harness.worker.acp.update during prompt', () => {
    const state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.worker.acp.update',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      sessionUpdate: 'agent_thought_chunk',
      sessionId: 'sess-1',
    });

    expect(state.workers.implementer).toEqual({
      kind: 'implementer',
      status: 'running',
    });
  });

  it('tracks running via acp update then idle after round completion', () => {
    let state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'harness.worker.acp.update',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      sessionUpdate: 'tool_call_update',
    });
    expect(state.workers.implementer?.status).toBe('running');

    state = reduceDisplayState(state, {
      type: 'worker.round',
      dispatch: { ...TEST_DISPATCH, source: 'conductor' },
    });
    expect(state.workers.implementer?.status).toBe('idle');
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
    expect(state.workers.conductor).toEqual({
      kind: 'conductor',
      status: 'idle',
    });
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
    expect(state.workers.conductor).toEqual({
      kind: 'conductor',
      status: 'idle',
    });
  });

  it('tracks conductor in-flight lifecycle as running then idle', () => {
    let state = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'conductor.send.started',
      sendCount: 1,
      dispatchSource: 'operator',
    });
    expect(state.workers.conductor).toEqual({
      kind: 'conductor',
      status: 'running',
    });

    state = reduceDisplayState(state, {
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: 'done',
      workerDispatches: 0,
      workerFailures: 0,
    });
    expect(state.workers.conductor).toEqual({
      kind: 'conductor',
      status: 'idle',
    });
  });

  it('clears conductor in-flight on cancelled conductor.send', () => {
    const inFlight = reduceDisplayState(INITIAL_SESSION_DISPLAY_STATE, {
      type: 'conductor.send.started',
      sendCount: 2,
      dispatchSource: 'worker:implementer',
    });

    const state = reduceDisplayState(inFlight, {
      type: 'conductor.send',
      sendCount: 2,
      runId: 'run-2',
      status: 'cancelled',
      workerDispatches: 0,
      workerFailures: 0,
    });

    expect(state.workers.conductor).toEqual({
      kind: 'conductor',
      status: 'idle',
    });
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
      type: 'harness.worker.prompt.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'harness',
    });
    state = reduceDisplayState(state, {
      type: 'harness.worker.prompt.completed',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'harness',
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
