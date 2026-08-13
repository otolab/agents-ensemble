import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './session-event.js';
import {
  countWorkerOutcomesInBatch,
  dispatchBatchStateAfterSend,
  eventSourceKey,
  markContinuationConsumed,
  selectDispatchBatch,
} from './select-dispatch-batch.js';

function operator(text: string): SessionEvent {
  return { type: 'operator.message', text };
}

function workerCompleted(name: string): SessionEvent {
  return {
    type: 'worker.completed',
    result: {
      name,
      kind: name,
      acpSessionId: 'sess-1',
      status: 'finished',
      result: 'ok',
    },
  };
}

function workerFailed(name: string): SessionEvent {
  return {
    type: 'worker.failed',
    failure: {
      name,
      kind: name,
      error: 'boom',
    },
  };
}

function permission(id: string): SessionEvent {
  return {
    type: 'permission.pending',
    permission: {
      id,
      workerId: 'worker-1',
      createdAt: 1,
      request: { toolName: 'shell', sessionId: 'sess-1' },
    },
  };
}

function githubUpdate(count: number): SessionEvent {
  return {
    type: 'github.update',
    items: Array.from({ length: count }, (_, index) => ({
      id: `item-${index}`,
      kind: 'issue.comment' as const,
      summary: `comment ${index}`,
    })),
  };
}

describe('eventSourceKey', () => {
  it('maps event types to member keys', () => {
    expect(eventSourceKey(operator('hi'))).toBe('operator');
    expect(eventSourceKey(permission('p1'))).toBe('permission');
    expect(eventSourceKey(workerCompleted('implementer'))).toBe(
      'worker:implementer',
    );
    expect(eventSourceKey(workerFailed('reviewer'))).toBe('worker:reviewer');
  });
});

describe('selectDispatchBatch', () => {
  it('batches consecutive operator messages into one send', () => {
    const queue = [operator('one'), operator('two'), operator('three')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('operator');
    expect(result?.batch.events).toHaveLength(3);
    expect(result?.remainingQueue).toEqual([]);
  });

  it('batches all same-worker events in the queue snapshot', () => {
    const queue = [
      workerCompleted('implementer'),
      workerCompleted('reviewer'),
      workerCompleted('implementer'),
    ];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('worker:implementer');
    expect(result?.batch.events).toHaveLength(2);
    expect(result?.remainingQueue).toEqual([workerCompleted('reviewer')]);
  });

  it('prefers operator over worker events', () => {
    const queue = [workerCompleted('implementer'), operator('wait')];
    const result = selectDispatchBatch({
      queue,
      state: dispatchBatchStateAfterSend('worker:implementer'),
      autonomousTurns: 3,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('operator');
    expect(result?.remainingQueue).toEqual([workerCompleted('implementer')]);
  });

  it('uses continuation source only on the next select', () => {
    const queue = [
      workerCompleted('implementer'),
      workerCompleted('reviewer'),
    ];

    let state = dispatchBatchStateAfterSend('worker:implementer');
    const first = selectDispatchBatch({
      queue,
      state,
      autonomousTurns: 0,
      maxTurns: 5,
    });
    expect(first?.batch.sourceKey).toBe('worker:implementer');
    state = markContinuationConsumed(state, first!);
    state = dispatchBatchStateAfterSend(first!.batch.sourceKey);

    const second = selectDispatchBatch({
      queue: first!.remainingQueue,
      state,
      autonomousTurns: 1,
      maxTurns: 5,
    });
    expect(second?.batch.sourceKey).toBe('worker:reviewer');
  });

  it('does not keep continuation priority after it is consumed', () => {
    let state = dispatchBatchStateAfterSend('worker:implementer');
    const first = selectDispatchBatch({
      queue: [workerCompleted('implementer')],
      state,
      autonomousTurns: 0,
      maxTurns: 5,
    })!;
    state = markContinuationConsumed(state, first);
    state = dispatchBatchStateAfterSend(first.batch.sourceKey);

    const queue = [workerCompleted('reviewer'), workerCompleted('implementer')];
    const next = selectDispatchBatch({
      queue,
      state,
      autonomousTurns: 1,
      maxTurns: 5,
    });

    expect(next?.batch.sourceKey).toBe('worker:implementer');
    expect(next?.remainingQueue).toEqual([workerCompleted('reviewer')]);

    state = markContinuationConsumed(state, next!);
    state = dispatchBatchStateAfterSend(next!.batch.sourceKey);
    const third = selectDispatchBatch({
      queue: next!.remainingQueue,
      state,
      autonomousTurns: 2,
      maxTurns: 5,
    });
    expect(third?.batch.sourceKey).toBe('worker:reviewer');
  });

  it('prefers permission.pending over worker.completed', () => {
    const queue = [workerCompleted('implementer'), permission('perm-1')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('permission');
    expect(result?.remainingQueue).toEqual([workerCompleted('implementer')]);
  });

  it('prefers permission over worker continuation', () => {
    const queue = [
      permission('perm-1'),
      workerCompleted('implementer'),
    ];
    const result = selectDispatchBatch({
      queue,
      state: dispatchBatchStateAfterSend('worker:implementer'),
      autonomousTurns: 1,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('permission');
    expect(result?.remainingQueue).toEqual([workerCompleted('implementer')]);
  });

  it('does not apply continuation after non-worker dispatch', () => {
    const queue = [workerCompleted('implementer'), workerCompleted('reviewer')];
    const result = selectDispatchBatch({
      queue,
      state: dispatchBatchStateAfterSend('permission'),
      autonomousTurns: 1,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('worker:implementer');
    expect(result?.remainingQueue).toEqual([workerCompleted('reviewer')]);
  });

  it('batches worker.failed and worker.completed from the same worker', () => {
    const queue = [workerCompleted('implementer'), workerFailed('implementer')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('worker:implementer');
    expect(result?.batch.events).toHaveLength(2);
    expect(result?.batch.events.map((event) => event.type)).toEqual([
      'worker.completed',
      'worker.failed',
    ]);
    expect(result?.remainingQueue).toEqual([]);
  });

  it('returns undefined when max turns blocks worker events', () => {
    const queue = [workerCompleted('implementer')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 5,
      maxTurns: 5,
    });

    expect(result).toBeUndefined();
  });

  it('still batches operator messages at max turns', () => {
    const queue = [workerCompleted('implementer'), operator('a'), operator('b')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 5,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('operator');
    expect(result?.batch.events).toHaveLength(2);
    expect(result?.remainingQueue).toEqual([workerCompleted('implementer')]);
  });

  it('returns a single-event batch compatible with size-1 dispatch', () => {
    const queue = [workerCompleted('implementer')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.events).toHaveLength(1);
  });

  it('dispatches worker events before github.update', () => {
    const queue = [githubUpdate(1), workerCompleted('implementer')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('worker:implementer');
    expect(result?.remainingQueue).toEqual([githubUpdate(1)]);
  });

  it('batches consecutive github.update events', () => {
    const queue = [githubUpdate(1), githubUpdate(2)];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('github');
    expect(result?.batch.events).toHaveLength(2);
  });

  it('ignores inform-mode SessionEvent until a trigger event arrives', () => {
    const informCompleted: SessionEvent = {
      ...workerCompleted('implementer'),
      dispatchMode: 'inform',
    };
    const queue = [informCompleted, operator('hi')];
    const result = selectDispatchBatch({
      queue,
      state: {},
      autonomousTurns: 0,
      maxTurns: 5,
    });

    expect(result?.batch.sourceKey).toBe('operator');
    expect(result?.batch.events).toEqual([operator('hi')]);
    expect(result?.remainingQueue).toEqual([informCompleted]);
  });
});

describe('countWorkerOutcomesInBatch', () => {
  it('counts worker.completed and worker.failed', () => {
    expect(
      countWorkerOutcomesInBatch([
        workerCompleted('a'),
        workerFailed('b'),
        operator('hi'),
      ]),
    ).toEqual({ workerDispatches: 1, workerFailures: 1 });
  });
});
