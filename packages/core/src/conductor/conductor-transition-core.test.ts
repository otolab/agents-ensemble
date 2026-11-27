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
      payload: [operatorMessage],
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

  it('keeps queue and held items when shutdown precedes lease acquisition', () => {
    const operatorMessage: SessionEvent = {
      type: 'operator.message',
      text: 'do not send after shutdown',
    };
    const selected = stepConductorCore(
      createConductorCoreState({ queue: [operatorMessage] }),
      {
        type: 'dispatch.schedule',
        input: { maxTurns: 5 },
      },
    );
    expect(observations(selected.effects)).toContainEqual({
      type: 'scheduled',
      sourceKey: 'operator',
      events: [operatorMessage],
    });

    const shutdown = stepConductorCore(selected.state, {
      type: 'session.shutdown',
      mode: 'close',
    });
    const requestAfterShutdown = stepConductorCore(shutdown.state, {
      type: 'send.requested',
      attemptId: 'send-after-shutdown',
      id: 2,
      payload: [operatorMessage],
    });
    expect(actionEffects(requestAfterShutdown.effects)).toEqual([]);
    expect(requestAfterShutdown.state.lease).toBeUndefined();
    expect(requestAfterShutdown.state.queue).toEqual([operatorMessage]);

    const shutdownWinsStopCheck = stepConductorCore(
      {
        ...requestAfterShutdown.state,
        issueLoop: {
          autonomousTurns: 1,
          maxTurns: 5,
          lastStatus: 'finished',
          dispatchesThisTurn: 0,
        },
      },
      { type: 'issueLoop.driverStopCheck', phase: 'idle' },
    );
    expect(actionEffects(shutdownWinsStopCheck.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'stop',
        stopReason: 'interrupted',
      },
    ]);

    const heldEvent: SessionEvent = {
      type: 'worker.completed',
      result: {
        name: 'implementer',
        kind: 'implementer',
        acpSessionId: 'worker-session',
        status: 'finished',
        result: 'held result',
      },
    };
    const heldShutdown = stepConductorCore(
      createConductorCoreState({
        heldEvents: [heldEvent],
      }),
      { type: 'session.shutdown', mode: 'signal' },
    );
    const heldRequestAfterShutdown = stepConductorCore(heldShutdown.state, {
      type: 'send.requested',
      attemptId: 'held-after-shutdown',
      id: 4,
      payload: { events: [heldEvent], sourceKey: 'dispatch-hold' },
    });
    expect(actionEffects(heldRequestAfterShutdown.effects)).toEqual([]);
    expect(heldRequestAfterShutdown.state.lease).toBeUndefined();
    expect(heldRequestAfterShutdown.state.heldEvents).toEqual([heldEvent]);
  });

  it('keeps queue payload ownership and accepts started/result after reentrant shutdown', () => {
    const operatorMessage: SessionEvent = {
      type: 'operator.message',
      text: 'selected input',
    };
    const payload = {
      events: [operatorMessage],
      sourceKey: 'operator',
      operatorInputTexts: ['selected input'],
    };
    const leased = stepConductorCore(
      createConductorCoreState({ queue: [operatorMessage] }),
      {
        type: 'send.requested',
        attemptId: 'send-1',
        id: 1,
        payload,
      },
    );
    expect(actionEffects(leased.effects)).toEqual([
      { type: 'startSend', attemptId: 'send-1', payload },
    ]);
    expect(leased.state.lease).toEqual({
      kind: 'send',
      attemptId: 'send-1',
      id: 1,
      payload,
    });

    // Driver order after beginSend: remove the queue batch, then synchronous
    // callbacks may re-enter and request shutdown before send.started.
    const removed = stepConductorCore(leased.state, {
      type: 'queue.remove',
      events: [operatorMessage],
    });
    expect(removed.state.queue).toEqual([]);
    const shutdownAfterRemoval = stepConductorCore(removed.state, {
      type: 'session.shutdown',
      mode: 'signal',
    });
    expect(shutdownAfterRemoval.state.lease).toEqual(leased.state.lease);

    const startedAfterShutdown = stepConductorCore(
      shutdownAfterRemoval.state,
      {
        type: 'send.started',
        attemptId: 'send-1',
        sourceKey: 'operator',
        events: [operatorMessage],
      },
    );
    expect(observations(startedAfterShutdown.effects)).toEqual([
      {
        type: 'dispatched',
        attemptId: 'send-1',
        sourceKey: 'operator',
        events: [operatorMessage],
      },
    ]);
    expect(startedAfterShutdown.state.lease).toEqual(leased.state.lease);
    expect(startedAfterShutdown.state.sendStartedAttemptId).toBe('send-1');

    const settledAfterShutdown = stepConductorCore(startedAfterShutdown.state, {
      type: 'send.result',
      attemptId: 'send-1',
      completed: true,
    });
    expect(observations(settledAfterShutdown.effects)).toEqual([
      {
        type: 'send.result',
        attemptId: 'send-1',
        completed: true,
      },
    ]);
    expect(settledAfterShutdown.state.lease).toBeUndefined();
    expect(settledAfterShutdown.state.queue).toEqual([]);
  });

  it('removes held payload only after lease and retains it through shutdown result', () => {
    const heldEvent: SessionEvent = {
      type: 'worker.completed',
      result: {
        name: 'implementer',
        kind: 'implementer',
        acpSessionId: 'worker-session',
        status: 'finished',
        result: 'held result',
      },
    };
    const payload = {
      events: [heldEvent],
      sourceKey: 'dispatch-hold',
    };
    const leased = stepConductorCore(
      createConductorCoreState({
        heldEvents: [heldEvent],
      }),
      {
        type: 'send.requested',
        attemptId: 'held-send',
        id: 1,
        payload,
      },
    );
    expect(actionEffects(leased.effects)).toEqual([
      { type: 'startSend', attemptId: 'held-send', payload },
    ]);
    expect(leased.state.heldEvents).toEqual([heldEvent]);
    expect(leased.state.lease).toMatchObject({ kind: 'send', payload });

    const removed = stepConductorCore(leased.state, {
      type: 'dispatchHold.remove',
      events: [heldEvent],
    });
    expect(removed.state.heldEvents).toEqual([]);
    expect(actionEffects(removed.effects)).toEqual([
      {
        type: 'dispatchHoldChanged',
        status: 'updated',
        hold: false,
        heldEventCount: 0,
      },
    ]);
    const shutdown = stepConductorCore(removed.state, {
      type: 'session.shutdown',
      mode: 'exit',
    });
    expect(shutdown.state.lease).toEqual(leased.state.lease);

    const started = stepConductorCore(shutdown.state, {
      type: 'send.started',
      attemptId: 'held-send',
      sourceKey: 'dispatch-hold',
      events: [heldEvent],
    });
    const settled = stepConductorCore(started.state, {
      type: 'send.result',
      attemptId: 'held-send',
      completed: false,
      failureClass: 'transport',
    });
    expect(observations(started.effects)).toEqual([
      {
        type: 'dispatched',
        attemptId: 'held-send',
        sourceKey: 'dispatch-hold',
        events: [heldEvent],
      },
    ]);
    expect(observations(settled.effects)).toEqual([
      {
        type: 'send.result',
        attemptId: 'held-send',
        completed: false,
        failureClass: 'transport',
      },
    ]);
    expect(settled.state.lease).toBeUndefined();
    expect(settled.state.heldEvents).toEqual([]);
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
    const stillRunning = stepConductorCore(
      createConductorCoreState({
        issueLoop: {
        autonomousTurns: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        runningWorkers: 1,
        },
      }),
      { type: 'issueLoop.stopCheck' },
    );
    expect(actionEffects(stillRunning.effects)).toEqual([
      {
        type: 'issueLoopStop',
        shouldStop: false,
        stopReason: 'completed',
      },
    ]);

    const stopped = stepConductorCore(
      createConductorCoreState({
        issueLoop: {
        autonomousTurns: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        },
      }),
      { type: 'issueLoop.stopCheck' },
    );
    expect(actionEffects(stopped.effects)).toEqual([
      {
        type: 'issueLoopStop',
        shouldStop: true,
        stopReason: 'completed',
      },
    ]);
  });

  it('keeps Driver stop priority, hold suppression, recovery confirmation, and inbox drain in the reducer', () => {
    const heldEvent: SessionEvent = {
      type: 'github.update',
      items: [{ id: 'update-1', kind: 'issue.comment', summary: 'update' }],
    };
    const stoppedLoop = {
      autonomousTurns: 1,
      maxTurns: 5,
      lastStatus: 'finished',
      dispatchesThisTurn: 0,
      runningWorkers: 0,
      pendingPermissions: 0,
      openQuestions: 0,
      continueOnConductorError: false,
      stopOnUnansweredInput: false,
    };
    const held = stepConductorCore(
      createConductorCoreState({
        issueLoop: stoppedLoop,
        heldEvents: [heldEvent],
      }),
      { type: 'issueLoop.driverStopCheck' },
    );
    expect(actionEffects(held.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'continue',
        stopReason: 'completed',
      },
    ]);
    expect(held.state.postLoopWaiting).toBe(false);

    const confirmationOverridesHold = stepConductorCore(
      createConductorCoreState({
        issueLoop: { ...stoppedLoop, lastStatus: 'error' },
        queue: [
          {
            type: 'operator.message',
            text: 'must not override recovery confirmation',
            delivery: 'idle',
          },
        ],
        heldEvents: [heldEvent],
        recoveryConfirmationRequired: true,
      }),
      { type: 'issueLoop.driverStopCheck', phase: 'idle' },
    );
    expect(actionEffects(confirmationOverridesHold.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'stop',
        stopReason: 'error',
      },
    ]);

    const cancelledConfirmation = stepConductorCore(
      createConductorCoreState({
        issueLoop: { ...stoppedLoop, lastStatus: 'cancelled' },
        heldEvents: [heldEvent],
        recoveryConfirmationRequired: true,
      }),
      { type: 'issueLoop.driverStopCheck' },
    );
    expect(actionEffects(cancelledConfirmation.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'stop',
        stopReason: 'cancelled',
      },
    ]);
    const confirmationGate = stepConductorCore(
      createConductorCoreState({
        issueLoop: { ...stoppedLoop, lastStatus: 'cancelled' },
        recoveryConfirmationRequired: true,
      }),
      { type: 'issueLoop.confirmationGate' },
    );
    expect(actionEffects(confirmationGate.effects)).toEqual([
      {
        type: 'issueLoopConfirmationGate',
        shouldStop: true,
        stopReason: 'cancelled',
      },
    ]);

    const recoveryWait = stepConductorCore(
      createConductorCoreState({
        issueLoop: { ...stoppedLoop, lastStatus: 'error' },
        recoveryConfirmationRequired: true,
        operatorCanInspectRecovery: true,
      }),
      { type: 'issueLoop.driverStopCheck' },
    );
    expect(actionEffects(recoveryWait.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'continue',
        stopReason: 'error',
        notifyIssueLoopStop: true,
      },
    ]);
    expect(recoveryWait.state.postLoopWaiting).toBe(true);

    const recoveryAlreadyReported = stepConductorCore(
      recoveryWait.state,
      { type: 'issueLoop.driverStopCheck' },
    );
    expect(actionEffects(recoveryAlreadyReported.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'continue',
        stopReason: 'error',
      },
    ]);

    const drainRequested = stepConductorCore(
      createConductorCoreState({ issueLoop: stoppedLoop }),
      { type: 'issueLoop.driverStopCheck', phase: 'idle' },
    );
    expect(actionEffects(drainRequested.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'drainWorkerInbox',
        stopReason: 'completed',
        idleOperatorMessageReady: false,
        idleStopCheckQueueEmpty: true,
      },
    ]);

    const workerOutcome: SessionEvent = {
      type: 'worker.failed',
      failure: {
        workerId: 'worker-1',
        name: 'implementer',
        kind: 'implementer',
        error: 'failed',
        issueUrl: 'https://github.com/otolab/agents-ensemble/issues/1',
      },
    };
    const workerArrivedDuringDrain = stepConductorCore(
      createConductorCoreState({
        issueLoop: stoppedLoop,
        queue: [workerOutcome],
        workerInboxDrained: true,
      }),
      { type: 'issueLoop.driverStopCheck' },
    );
    expect(actionEffects(workerArrivedDuringDrain.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'continue',
        stopReason: 'completed',
      },
    ]);

    const idleArrivesDuringDrain = stepConductorCore(
      {
        ...drainRequested.state,
        queue: [
          {
            type: 'operator.message',
            text: 'arrived during drain',
            delivery: 'idle',
          },
        ],
        workerInboxDrained: true,
      },
      { type: 'issueLoop.driverStopCheck', phase: 'idle' },
    );
    expect(actionEffects(idleArrivesDuringDrain.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'stop',
        stopReason: 'completed',
      },
    ]);
    expect(idleArrivesDuringDrain.state.idleStopCheckQueueEmpty).toBe(true);
  });

  it('decides idle operator eligibility from queue, held work, and worker projections', () => {
    const idleMessage: SessionEvent = {
      type: 'operator.message',
      text: 'later',
      delivery: 'idle',
    };
    const workerOutcome: SessionEvent = {
      type: 'worker.failed',
      failure: {
        workerId: 'worker-1',
        name: 'implementer',
        kind: 'implementer',
        error: 'failed',
        issueUrl: 'https://github.com/otolab/agents-ensemble/issues/1',
      },
    };
    const inputState = {
      issueLoop: {
        autonomousTurns: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        runningWorkers: 0,
      },
      queue: [idleMessage],
    };
    const idleOnly = stepConductorCore(
      createConductorCoreState(inputState),
      { type: 'dispatch.idleOperatorMessageGate' },
    );
    expect(actionEffects(idleOnly.effects)).toEqual([
      { type: 'idleOperatorMessageGate', allowed: true },
    ]);

    const workerTakesPriority = stepConductorCore(
      createConductorCoreState({
        ...inputState,
        issueLoop: { ...inputState.issueLoop, runningWorkers: 1 },
        queue: [idleMessage, workerOutcome],
      }),
      { type: 'dispatch.idleOperatorMessageGate' },
    );
    expect(actionEffects(workerTakesPriority.effects)).toEqual([
      { type: 'idleOperatorMessageGate', allowed: false },
    ]);

    const queuedTriggerTakesPriority = stepConductorCore(
      createConductorCoreState({
        ...inputState,
        queue: [idleMessage, workerOutcome],
      }),
      { type: 'dispatch.idleOperatorMessageGate' },
    );
    expect(actionEffects(queuedTriggerTakesPriority.effects)).toEqual([
      { type: 'idleOperatorMessageGate', allowed: false },
    ]);

    const releasedHeldTriggerTakesPriority = stepConductorCore(
      createConductorCoreState({
        ...inputState,
        dispatchHold: false,
        heldEvents: [workerOutcome],
      }),
      { type: 'dispatch.idleOperatorMessageGate' },
    );
    expect(actionEffects(releasedHeldTriggerTakesPriority.effects)).toEqual([
      { type: 'idleOperatorMessageGate', allowed: false },
    ]);

    const activeHoldDoesNotFlushHeldWork = stepConductorCore(
      createConductorCoreState({
        ...inputState,
        dispatchHold: true,
        heldEvents: [workerOutcome],
      }),
      { type: 'dispatch.idleOperatorMessageGate' },
    );
    expect(actionEffects(activeHoldDoesNotFlushHeldWork.effects)).toEqual([
      { type: 'idleOperatorMessageGate', allowed: true },
    ]);

    const idleMessageOverridesPostLoopStop = stepConductorCore(
      createConductorCoreState({
        issueLoop: {
          autonomousTurns: 1,
          maxTurns: 5,
          lastStatus: 'finished',
          dispatchesThisTurn: 0,
          runningWorkers: 0,
          stopOnUnansweredInput: false,
        },
        queue: [idleMessage],
        workerInboxDrained: true,
      }),
      { type: 'issueLoop.driverStopCheck' },
    );
    expect(actionEffects(idleMessageOverridesPostLoopStop.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'continue',
        stopReason: 'completed',
      },
    ]);

    const oneShotStillStops = stepConductorCore(
      createConductorCoreState({
        issueLoop: {
          autonomousTurns: 1,
          maxTurns: 5,
          lastStatus: 'finished',
          dispatchesThisTurn: 0,
          runningWorkers: 0,
          stopOnUnansweredInput: true,
        },
        queue: [idleMessage],
        workerInboxDrained: true,
      }),
      { type: 'issueLoop.driverStopCheck' },
    );
    expect(actionEffects(oneShotStillStops.effects)).toEqual([
      {
        type: 'issueLoopDecision',
        decision: 'stop',
        stopReason: 'completed',
      },
    ]);
  });

  it('projects Cursor bootstrap gating and completion as reducer decisions', () => {
    const undecided = stepConductorCore(
      createConductorCoreState({
        cursorBootstrap: {
          backend: 'cursor',
          status: 'unknown',
          skipInitialSend: false,
          completedThisDriver: false,
        },
      }),
      { type: 'cursorBootstrap.check' },
    );
    expect(actionEffects(undecided.effects)).toEqual([
      {
        type: 'cursorBootstrapDecision',
        needsDecision: true,
        pending: false,
      },
    ]);

    const incomplete = stepConductorCore(
      createConductorCoreState({
        cursorBootstrap: {
          backend: 'cursor',
          status: 'incomplete',
          skipInitialSend: false,
          completedThisDriver: false,
        },
      }),
      { type: 'cursorBootstrap.check' },
    );
    expect(actionEffects(incomplete.effects)).toEqual([
      {
        type: 'cursorBootstrapDecision',
        needsDecision: false,
        pending: true,
      },
    ]);
    const incompleteSend = stepConductorCore(incomplete.state, {
      type: 'cursorBootstrap.dispatchResult',
      status: 'cancelled',
      bootstrapIncluded: true,
    });
    expect(
      actionEffects(
        stepConductorCore(incompleteSend.state, {
          type: 'cursorBootstrap.check',
        }).effects,
      ),
    ).toEqual([
      {
        type: 'cursorBootstrapDecision',
        needsDecision: false,
        pending: true,
      },
    ]);
    const sent = stepConductorCore(incomplete.state, {
      type: 'cursorBootstrap.dispatchResult',
      status: 'finished',
      bootstrapIncluded: true,
    });
    const afterSend = stepConductorCore(sent.state, {
      type: 'cursorBootstrap.check',
    });
    expect(actionEffects(afterSend.effects)).toEqual([
      {
        type: 'cursorBootstrapDecision',
        needsDecision: false,
        pending: false,
      },
    ]);

    const nonCursor = stepConductorCore(
      createConductorCoreState({
        cursorBootstrap: {
          backend: 'other',
          status: 'incomplete',
          skipInitialSend: false,
          completedThisDriver: false,
        },
      }),
      { type: 'cursorBootstrap.check' },
    );
    expect(actionEffects(nonCursor.effects)).toEqual([
      {
        type: 'cursorBootstrapDecision',
        needsDecision: false,
        pending: false,
      },
    ]);

    const legacyCursor = createConductorCoreState({
      cursorBootstrap: {
        backend: 'cursor',
        skipInitialSend: false,
        completedThisDriver: false,
      },
    });
    const legacyPending = stepConductorCore(legacyCursor, {
      type: 'cursorBootstrap.check',
    });
    expect(actionEffects(legacyPending.effects)).toEqual([
      {
        type: 'cursorBootstrapDecision',
        needsDecision: false,
        pending: true,
      },
    ]);
    const legacySent = stepConductorCore(legacyPending.state, {
      type: 'cursorBootstrap.dispatchResult',
      status: 'finished',
      bootstrapIncluded: true,
    });
    expect(
      actionEffects(
        stepConductorCore(legacySent.state, {
          type: 'cursorBootstrap.check',
        }).effects,
      ),
    ).toEqual([
      {
        type: 'cursorBootstrapDecision',
        needsDecision: false,
        pending: false,
      },
    ]);
  });
});
