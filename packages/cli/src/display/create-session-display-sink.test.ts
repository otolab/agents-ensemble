import { describe, expect, it, vi } from 'vitest';
import { createSessionDisplaySink } from './create-session-display-sink.js';
import { createStubSessionDisplayBackend } from './stub-session-display-backend.js';
import { createStringSessionDisplayBackend } from './string-session-display-backend.js';

describe('createSessionDisplaySink', () => {
  it('updates backend state and triggers reprompt on open question', () => {
    const stub = createStubSessionDisplayBackend();
    const onOpenQuestionEnqueued = vi.fn();
    const sink = createSessionDisplaySink({
      backend: stub.backend,
      onOpenQuestionEnqueued,
    });

    sink({
      type: 'open.question.enqueued',
      question: {
        id: 'inq-1',
        question: 'approve?',
        responseType: 'yes_no',
        source: 'conductor',
        status: 'open',
        askedAt: 1,
      },
    });

    expect(stub.getState().openQuestions).toHaveLength(1);
    expect(onOpenQuestionEnqueued).toHaveBeenCalledTimes(1);
  });

  it('does not render harness-only events on noop path', () => {
    const stub = createStubSessionDisplayBackend();
    const sink = createSessionDisplaySink({ backend: stub.backend });

    sink({
      type: 'harness.worktree',
      path: '/wt',
      branch: 'b',
      mode: 'isolated',
    });

    expect(stub.getRenders()).toHaveLength(0);
  });
});

describe('createStringSessionDisplayBackend', () => {
  it('writes operator and conductor dialogue to stdout', () => {
    const writeStdout = vi.fn();
    const backend = createStringSessionDisplayBackend({ writeStdout });

    backend.render(
      { workers: {}, conductorOutput: null, openQuestions: [] },
      { workers: {}, conductorOutput: null, openQuestions: [] },
      { type: 'operator.input', conductorTurn: 1, text: 'hello' },
    );
    backend.render(
      { workers: {}, conductorOutput: 'ok', openQuestions: [] },
      { workers: {}, conductorOutput: null, openQuestions: [] },
      {
        type: 'conductor.send',
        sendCount: 1,
        runId: 'run-1',
        status: 'finished',
        result: 'ok',
        workerDispatches: 0,
        workerFailures: 0,
      },
    );

    expect(writeStdout).toHaveBeenCalledWith('\noperator> hello\n');
    expect(writeStdout).toHaveBeenCalledWith('\nconductor> ok\n');
  });
});
