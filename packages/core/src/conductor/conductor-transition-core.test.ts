import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './session/session-event.js';
import {
  createConductorCoreState,
  stepConductorCore,
} from './conductor-transition-core.js';

function actionEffects(
  effects: ReturnType<typeof stepConductorCore>['effects'],
) {
  return effects.flatMap((effect) =>
    effect.kind === 'action' ? [effect.action] : [],
  );
}

function observations(
  effects: ReturnType<typeof stepConductorCore>['effects'],
) {
  return effects.flatMap((effect) =>
    effect.kind === 'observation' ? [effect.observation] : [],
  );
}

function permission(id: string): SessionEvent {
  return {
    type: 'permission.pending',
    permission: {
      id,
      workerId: 'worker-1',
      createdAt: 1,
      request: { toolName: 'shell', sessionId: 'session-1' },
    },
  };
}

describe('stepConductorCore', () => {
  it('keeps selection, send lease acquisition, and actual send start distinct', () => {
    const operatorMessage: SessionEvent = {
      type: 'operator.message',
      text: 'continue',
    };
    const initial = createConductorCoreState({
      queue: [operatorMessage],
    });

    const scheduled = stepConductorCore(initial, {
      type: 'dispatch.schedule',
      input: {
        maxTurns: 5,
      },
    });
    expect(
      actionEffects(scheduled.effects).find(
        (effect) => effect.type === 'dispatchSelection',
      ),
    ).toMatchObject({
      type: 'dispatchSelection',
      result: {
        batch: { sourceKey: 'operator', events: [operatorMessage] },
      },
    });
    expect(observations(scheduled.effects)).toEqual([
      {
        type: 'scheduled',
        sourceKey: 'operator',
        events: [operatorMessage],
      },
    ]);
    expect(scheduled.state.lease).toBeUndefined();

    const leased = stepConductorCore(scheduled.state, {
      type: 'send.requested',
      attemptId: '1',
      id: 1,
      payload: [operatorMessage],
    });
    expect(actionEffects(leased.effects)).toEqual([
      { type: 'startSend', attemptId: '1', payload: [operatorMessage] },
    ]);
    expect(observations(leased.effects)).toEqual([]);
    expect(leased.state.lease).toEqual({
      kind: 'send',
      attemptId: '1',
      id: 1,
    });

    const started = stepConductorCore(leased.state, {
      type: 'send.started',
      attemptId: '1',
      sourceKey: 'operator',
      events: [operatorMessage],
    });
    expect(observations(started.effects)).toEqual([
      {
        type: 'dispatched',
        attemptId: '1',
        sourceKey: 'operator',
        events: [operatorMessage],
      },
    ]);
    expect(started.state.lease).toEqual(leased.state.lease);
    expect(initial.queue).toEqual([operatorMessage]);
  });

  it('models reconnect as a start effect and result event only', () => {
    const reconnecting = stepConductorCore(
      createConductorCoreState({
        agentAvailable: false,
        attentionAttemptId: 'send-1',
        lastFailureClass: 'transport',
      }),
      { type: 'reconnect.requested', attemptId: 'reconnect-2', id: 2 },
    );
    expect(actionEffects(reconnecting.effects)).toEqual([
      { type: 'startReconnect', attemptId: 'reconnect-2' },
    ]);

    const recovered = stepConductorCore(reconnecting.state, {
      type: 'reconnect.result',
      attemptId: 'reconnect-2',
      succeeded: true,
    });
    expect(recovered.state.agentAvailable).toBe(true);
    expect(recovered.state.attentionAttemptId).toBe('send-1');
    expect(recovered.state.lastFailureClass).toBe('transport');
    expect(observations(recovered.effects)).toEqual([
      {
        type: 'reconnect.result',
        attemptId: 'reconnect-2',
        succeeded: true,
      },
    ]);

    const failedAttempt = stepConductorCore(
      createConductorCoreState({ agentAvailable: false }),
      { type: 'reconnect.requested', attemptId: 'reconnect-3', id: 3 },
    );
    const unavailable = stepConductorCore(failedAttempt.state, {
      type: 'reconnect.result',
      attemptId: 'reconnect-3',
      succeeded: false,
    });
    expect(unavailable.state.agentAvailable).toBe(false);
    expect(unavailable.state.lease).toBeUndefined();
  });

  it('applies send results only to the active attempt and preserves confirmation rules', () => {
    const initial = createConductorCoreState();
    const leased = stepConductorCore(initial, {
      type: 'send.requested',
      attemptId: 'send-1',
      id: 1,
      payload: undefined,
    });
    const staleResult = stepConductorCore(leased.state, {
      type: 'send.result',
      attemptId: 'stale',
      completed: false,
      failureClass: 'transport',
    });
    expect(staleResult.state).toBe(leased.state);
    expect(staleResult.effects).toEqual([]);

    const failed = stepConductorCore(leased.state, {
      type: 'send.result',
      attemptId: 'send-1',
      completed: false,
      failureClass: 'transport',
    });
    expect(failed.state.lease).toBeUndefined();
    expect(failed.state.attentionAttemptId).toBe('send-1');
    expect(failed.state.lastFailureClass).toBe('transport');

    const confirmed = stepConductorCore(failed.state, {
      type: 'recovery.confirm',
      expectedAttemptId: 'send-1',
    });
    expect(confirmed.state.attentionAttemptId).toBeUndefined();
    expect(confirmed.state.lastFailureClass).toBe('transport');
  });

  it('holds eligible events in arrival order and leaves bypass events queued', () => {
    const events: SessionEvent[] = [
      { type: 'operator.message', text: 'operator' },
      { type: 'operator.reconnect' },
      {
        type: 'permission.stall',
        message: 'stalled',
        pendingPermissionIds: ['p1'],
        pendingPermissionCount: 1,
        oldestPermissionCreatedAt: 1,
        stallAgeMs: 10,
        stallThresholdMs: 10,
      },
      { type: 'github.update', items: [] },
      {
        type: 'worker.session.recovered',
        name: 'worker',
        kind: 'worker',
        reason: 'prompt_history_unreadable',
      },
    ];
    const transition = stepConductorCore(
      createConductorCoreState({
        dispatchHold: true,
        queue: events,
      }),
      { type: 'dispatchHold.buffer', queue: events },
    );

    expect(transition.state.queue).toEqual(events.slice(0, 3));
    expect(transition.state.heldEvents).toEqual(events.slice(3));
    expect(actionEffects(transition.effects)).toEqual([
      {
        type: 'dispatchHoldChanged',
        status: 'updated',
        hold: true,
        heldEventCount: 2,
      },
    ]);
  });

  it('prunes stale permissions using the supplied owner snapshot', () => {
    const staleInQueue = permission('stale-queue');
    const liveInQueue = permission('live');
    const staleHeld = permission('stale-held');
    const transition = stepConductorCore(
      createConductorCoreState({
        dispatchHold: true,
        heldEvents: [staleHeld, permission('live')],
      }),
      {
        type: 'permissions.prune',
        queue: [staleInQueue, liveInQueue],
        pendingPermissionIds: ['live'],
      },
    );

    expect(transition.state.queue).toEqual([liveInQueue]);
    expect(transition.state.heldEvents).toEqual([permission('live')]);
    expect(actionEffects(transition.effects)).toEqual([
      {
        type: 'dispatchHoldChanged',
        status: 'updated',
        hold: true,
        heldEventCount: 1,
      },
    ]);
  });

  it('returns stop decisions from explicit state projections', () => {
    const stillRunning = stepConductorCore(createConductorCoreState(), {
      type: 'issueLoop.stopCheck',
      input: {
        autonomousTurns: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        runningWorkers: 1,
      },
    });
    expect(actionEffects(stillRunning.effects)).toEqual([
      {
        type: 'issueLoopStop',
        shouldStop: false,
        stopReason: 'completed',
      },
    ]);

    const stopped = stepConductorCore(stillRunning.state, {
      type: 'issueLoop.stopCheck',
      input: {
        autonomousTurns: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
      },
    });
    expect(actionEffects(stopped.effects)).toEqual([
      {
        type: 'issueLoopStop',
        shouldStop: true,
        stopReason: 'completed',
      },
    ]);
  });
});
