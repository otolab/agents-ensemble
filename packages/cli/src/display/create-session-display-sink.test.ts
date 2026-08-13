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

  it('renders when harness.session.workers seeds profile workers', () => {
    const stub = createStubSessionDisplayBackend();
    const sink = createSessionDisplaySink({ backend: stub.backend });

    sink({
      type: 'harness.session.workers',
      workers: [{ name: 'implementer', kind: 'implementer' }],
    });

    expect(stub.getRenders()).toHaveLength(1);
    expect(stub.getState().workers.implementer).toEqual({
      kind: 'implementer',
      status: 'idle',
    });
  });

  it('renders when harness.worker.state moves worker idle to running', () => {
    const stub = createStubSessionDisplayBackend();
    const sink = createSessionDisplaySink({ backend: stub.backend });

    sink({
      type: 'harness.session.workers',
      workers: [{ name: 'implementer', kind: 'implementer' }],
    });
    sink({
      type: 'harness.worker.state',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      state: 'processing',
    });

    expect(stub.getState().workers.implementer?.status).toBe('running');
  });

  it('renders when harness.worker.acp.update changes activity hint', () => {
    const stub = createStubSessionDisplayBackend();
    const sink = createSessionDisplaySink({ backend: stub.backend });

    sink({
      type: 'harness.worker.acp.update',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      sessionUpdate: 'agent_thought_chunk',
      sessionId: 'sess-1',
    });

    expect(stub.getState().workers.implementer).toEqual({
      kind: 'implementer',
      status: 'running',
      activity: 'thinking',
    });
    expect(stub.getRenders()).toHaveLength(1);
    expect(stub.getRenders()[0]?.event.type).toBe('harness.worker.acp.update');
    expect(stub.getRenders()[0]?.state.workers.implementer?.status).toBe(
      'running',
    );
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
