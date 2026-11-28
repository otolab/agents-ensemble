import { describe, expect, it } from 'vitest';
import {
  canDispatchConductorCore,
  createConductorCoreState,
  stepConductorCore,
} from './conductor-transition-core.js';
import type {
  ConductorCoreAction,
  ConductorCoreObservation,
} from './conductor-transition-core.js';
import type { ConductorInboxItem } from './conductor-inbox-transition-core.js';

function actions(
  effects: ReturnType<typeof stepConductorCore>['effects'],
): ConductorCoreAction[] {
  return effects.flatMap((effect) =>
    effect.kind === 'action' ? [effect.action] : [],
  );
}

function observations(
  effects: ReturnType<typeof stepConductorCore>['effects'],
): ConductorCoreObservation[] {
  return effects.flatMap((effect) =>
    effect.kind === 'observation' ? [effect.observation] : [],
  );
}

describe('conductor durable inbox transition projection', () => {
  it('accepts an item only after the inbox commit result', () => {
    const item: ConductorInboxItem = {
      id: 'operator-item-1',
      payload: { text: 'resume the work' },
      holdClass: 'ordinary',
    };
    const requested = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.accept',
      item,
    });
    expect(requested.state.durableInbox.pendingItems).toEqual([]);
    expect(requested.state.durableInbox.pendingAcceptances).toEqual([item]);
    expect(actions(requested.effects)).toEqual([
      { type: 'persistInboxItem', item },
    ]);

    const failed = stepConductorCore(requested.state, {
      type: 'inbox.accept.result',
      itemId: item.id,
      committed: false,
    });
    expect(failed.state.durableInbox.pendingItems).toEqual([]);
    expect(observations(failed.effects)).toEqual([]);

    const requestedAgain = stepConductorCore(failed.state, {
      type: 'inbox.accept',
      item,
    });
    const committed = stepConductorCore(requestedAgain.state, {
      type: 'inbox.accept.result',
      itemId: item.id,
      committed: true,
    });
    expect(committed.state.durableInbox.pendingItems).toEqual([item]);
    expect(observations(committed.effects)).toEqual([
      { type: 'inbox.accepted', item },
    ]);
  });

  it('restores the same unknown batch, counts actual invocations, and keeps ack retry separate', () => {
    const item: ConductorInboxItem = {
      id: 'item-1',
      payload: { text: 'original payload' },
      holdClass: 'deliveryUnknown',
    };
    const laterItem: ConductorInboxItem = {
      id: 'github-1',
      payload: { text: 'connectivity recovered' },
      holdClass: 'githubConnectivity',
    };
    const ordinaryItem: ConductorInboxItem = {
      id: 'ordinary-1',
      payload: { text: 'ordinary pending notice' },
      holdClass: 'ordinary',
    };
    const restored = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [item, laterItem, ordinaryItem],
      dispatchHold: true,
      deliveryUnknownBatches: [
        {
          id: 'batch-1',
          itemIds: [item.id],
          automaticSendInvocations: 2,
          processResumeNotice: { text: 'the process resumed' },
        },
      ],
    });

    const deniedAsOrdinary = stepConductorCore(restored.state, {
      type: 'inbox.batch.select',
      batchId: 'new-batch',
      itemIds: [ordinaryItem.id],
    });
    expect(deniedAsOrdinary.state.durableInbox.batches).toHaveLength(1);
    const connectivityBypass = stepConductorCore(restored.state, {
      type: 'inbox.batch.select',
      batchId: 'connectivity-batch',
      itemIds: [laterItem.id],
    });
    expect(connectivityBypass.state.durableInbox.batches).toHaveLength(2);

    const retry = stepConductorCore(restored.state, {
      type: 'inbox.batch.start',
      batchId: 'batch-1',
      attemptId: 'attempt-3',
      reason: 'restartRecovery',
    });
    expect(actions(retry.effects)).toContainEqual({
      type: 'startInboxBatchSend',
      attemptId: 'attempt-3',
      batchId: 'batch-1',
      itemIds: [item.id],
      reason: 'restartRecovery',
      processResumeNotice: { text: 'the process resumed' },
    });

    const invoked = stepConductorCore(retry.state, {
      type: 'inbox.send.invoked',
      attemptId: 'attempt-3',
    });
    expect(
      invoked.state.durableInbox.batches[0]?.automaticSendInvocations,
    ).toBe(3);
    expect(observations(invoked.effects)).toContainEqual({
      type: 'inbox.dispatched',
      attemptId: 'attempt-3',
      batchId: 'batch-1',
      itemIds: [item.id],
    });
    const exhausted = stepConductorCore(invoked.state, {
      type: 'inbox.send.result',
      attemptId: 'attempt-3',
      outcome: 'deliveryUnknown',
    });
    expect(exhausted.state.durableInbox.stopGates).toContainEqual({
      kind: 'retryExhausted',
      batchId: 'batch-1',
    });
    expect(
      stepConductorCore(exhausted.state, {
        type: 'inbox.batch.select',
        batchId: 'held-github',
        itemIds: [laterItem.id],
      }).state.durableInbox.batches,
    ).toHaveLength(1);

    const attentionConfirmed = stepConductorCore(exhausted.state, {
      type: 'recovery.confirm',
      expectedAttemptId: 'attempt-3',
    });
    expect(attentionConfirmed.state.durableInbox.stopGates).toEqual([
      { kind: 'retryExhausted', batchId: 'batch-1' },
    ]);
    const explicitResend = stepConductorCore(attentionConfirmed.state, {
      type: 'inbox.batch.start',
      batchId: 'batch-1',
      attemptId: 'operator-resend-1',
      reason: 'operatorResend',
    });
    const explicitInvocation = stepConductorCore(explicitResend.state, {
      type: 'inbox.send.invoked',
      attemptId: 'operator-resend-1',
    });
    expect(
      explicitInvocation.state.durableInbox.batches[0]
        ?.automaticSendInvocations,
    ).toBe(3);

    const finished = stepConductorCore(explicitInvocation.state, {
      type: 'inbox.send.result',
      attemptId: 'operator-resend-1',
      outcome: 'finished',
    });
    expect(finished.state.durableInbox.stopGates).toEqual([
      { kind: 'retryExhausted', batchId: 'batch-1' },
      { kind: 'ackPending', batchId: 'batch-1' },
    ]);
    const ackFailed = stepConductorCore(finished.state, {
      type: 'inbox.deliveryAck.result',
      batchId: 'batch-1',
      committed: false,
    });
    expect(actions(ackFailed.effects)).toEqual([
      { type: 'retryInboxDeliveryAck', batchId: 'batch-1' },
      {
        type: 'notifyInboxOperator',
        reason: 'ackPending',
        batchId: 'batch-1',
      },
    ]);

    const ackCommitted = stepConductorCore(ackFailed.state, {
      type: 'inbox.deliveryAck.result',
      batchId: 'batch-1',
      committed: true,
    });
    expect(ackCommitted.state.durableInbox.pendingItems).toEqual([
      laterItem,
      ordinaryItem,
    ]);
    expect(ackCommitted.state.durableInbox.batches).toEqual([]);
    expect(ackCommitted.state.durableInbox.stopGates).toEqual([]);
  });

  it('projects unknown durable send results into shared lifecycle across the retry limit', () => {
    const item: ConductorInboxItem = {
      id: 'recovery-item',
      payload: { text: 'resume the original batch' },
      holdClass: 'deliveryUnknown',
    };
    const firstRestore = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [item],
      dispatchHold: true,
      deliveryUnknownBatches: [
        {
          id: 'recovery-batch',
          itemIds: [item.id],
          automaticSendInvocations: 1,
          processResumeNotice: { text: 'the process resumed' },
        },
      ],
    });
    const beforeLimitStart = stepConductorCore(firstRestore.state, {
      type: 'inbox.batch.start',
      batchId: 'recovery-batch',
      attemptId: 'recovery-before-limit',
      reason: 'restartRecovery',
    });
    expect(actions(beforeLimitStart.effects)).toContainEqual({
      type: 'startInboxBatchSend',
      attemptId: 'recovery-before-limit',
      batchId: 'recovery-batch',
      itemIds: [item.id],
      reason: 'restartRecovery',
      processResumeNotice: { text: 'the process resumed' },
    });
    expect(beforeLimitStart.state.dispatchHold).toBe(true);

    const beforeLimitInvoked = stepConductorCore(beforeLimitStart.state, {
      type: 'inbox.send.invoked',
      attemptId: 'recovery-before-limit',
    });
    expect(
      beforeLimitInvoked.state.durableInbox.batches[0]
        ?.automaticSendInvocations,
    ).toBe(2);
    const beforeLimitUnknown = stepConductorCore(beforeLimitInvoked.state, {
      type: 'inbox.send.result',
      attemptId: 'recovery-before-limit',
      outcome: 'deliveryUnknown',
      failureClass: 'send_rejected',
      agentAvailable: false,
    });
    expect(beforeLimitUnknown.state.lease).toBeUndefined();
    expect(beforeLimitUnknown.state.agentAvailable).toBe(false);
    expect(beforeLimitUnknown.state.attentionAttemptId).toBe(
      'recovery-before-limit',
    );
    expect(beforeLimitUnknown.state.lastFailureClass).toBe('send_rejected');
    expect(beforeLimitUnknown.state.durableInbox.stopGates).toEqual([]);
    expect(beforeLimitUnknown.state.dispatchHold).toBe(true);
    expect(canDispatchConductorCore(beforeLimitUnknown.state)).toBe(false);
    expect(observations(beforeLimitUnknown.effects)).toContainEqual({
      type: 'send.result',
      attemptId: 'recovery-before-limit',
      completed: false,
      failureClass: 'send_rejected',
    });

    const sameProcessRetry = stepConductorCore(beforeLimitUnknown.state, {
      type: 'inbox.batch.start',
      batchId: 'recovery-batch',
      attemptId: 'same-process-retry',
      reason: 'restartRecovery',
    });
    expect(sameProcessRetry.state).toBe(beforeLimitUnknown.state);
    expect(actions(sameProcessRetry.effects)).toEqual([]);

    // A process restart supplies a fresh shared lifecycle projection while
    // the persisted inbox batch retains its actual invocation count.
    const afterRestart = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [item],
      dispatchHold: true,
      deliveryUnknownBatches: [
        {
          id: 'recovery-batch',
          itemIds: [item.id],
          automaticSendInvocations: 2,
          processResumeNotice: { text: 'the process resumed again' },
        },
      ],
    });
    const atLimitStart = stepConductorCore(afterRestart.state, {
      type: 'inbox.batch.start',
      batchId: 'recovery-batch',
      attemptId: 'recovery-at-limit',
      reason: 'restartRecovery',
    });
    expect(actions(atLimitStart.effects)).toContainEqual(
      expect.objectContaining({
        type: 'startInboxBatchSend',
        reason: 'restartRecovery',
      }),
    );
    const atLimitInvoked = stepConductorCore(atLimitStart.state, {
      type: 'inbox.send.invoked',
      attemptId: 'recovery-at-limit',
    });
    const atLimitUnknown = stepConductorCore(atLimitInvoked.state, {
      type: 'inbox.send.result',
      attemptId: 'recovery-at-limit',
      outcome: 'deliveryUnknown',
      failureClass: 'transport',
    });
    expect(
      atLimitUnknown.state.durableInbox.batches[0]
        ?.automaticSendInvocations,
    ).toBe(3);
    expect(atLimitUnknown.state.durableInbox.stopGates).toEqual([
      { kind: 'retryExhausted', batchId: 'recovery-batch' },
    ]);
    expect(atLimitUnknown.state.agentAvailable).toBe(true);
    expect(atLimitUnknown.state.attentionAttemptId).toBe('recovery-at-limit');
    expect(atLimitUnknown.state.lastFailureClass).toBe('transport');
    expect(atLimitUnknown.state.dispatchHold).toBe(true);
    expect(canDispatchConductorCore(atLimitUnknown.state)).toBe(false);

    const resendBeforeConfirmation = stepConductorCore(
      atLimitUnknown.state,
      {
        type: 'inbox.batch.start',
        batchId: 'recovery-batch',
        attemptId: 'resend-too-early',
        reason: 'operatorResend',
      },
    );
    expect(resendBeforeConfirmation.state).toBe(atLimitUnknown.state);
    expect(actions(resendBeforeConfirmation.effects)).toEqual([]);

    const reconnecting = stepConductorCore(atLimitUnknown.state, {
      type: 'reconnect.requested',
      attemptId: 'reconnect-after-failure',
      id: 4,
    });
    const reconnected = stepConductorCore(reconnecting.state, {
      type: 'reconnect.result',
      attemptId: 'reconnect-after-failure',
      succeeded: true,
    });
    expect(reconnected.state.agentAvailable).toBe(true);
    expect(reconnected.state.attentionAttemptId).toBe('recovery-at-limit');
    const confirmed = stepConductorCore(reconnected.state, {
      type: 'recovery.confirm',
      expectedAttemptId: 'recovery-at-limit',
    });
    expect(canDispatchConductorCore(confirmed.state)).toBe(false);
    const explicitResend = stepConductorCore(confirmed.state, {
      type: 'inbox.batch.start',
      batchId: 'recovery-batch',
      attemptId: 'operator-resend-after-confirmation',
      reason: 'operatorResend',
    });
    expect(actions(explicitResend.effects)).toContainEqual(
      expect.objectContaining({
        type: 'startInboxBatchSend',
        attemptId: 'operator-resend-after-confirmation',
        reason: 'operatorResend',
      }),
    );
    expect(explicitResend.state.dispatchHold).toBe(true);
    expect(
      explicitResend.state.durableInbox.batches[0]
        ?.automaticSendInvocations,
    ).toBe(3);
  });

  it('does not let a delivery-unknown hold bypass cross another inbox stop gate', () => {
    const recoveryItem: ConductorInboxItem = {
      id: 'recovery-item',
      payload: { text: 'unknown delivery result' },
      holdClass: 'deliveryUnknown',
    };
    const oversizedItem: ConductorInboxItem = {
      id: 'oversized-item',
      payload: { text: 'size blocked batch' },
      holdClass: 'ordinary',
    };
    const restored = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [recoveryItem, oversizedItem],
      dispatchHold: true,
      deliveryUnknownBatches: [
        {
          id: 'recovery-batch',
          itemIds: [recoveryItem.id],
          automaticSendInvocations: 1,
          processResumeNotice: { text: 'resume' },
        },
      ],
      sizeBlockedBatches: [
        {
          id: 'size-batch',
          itemIds: [oversizedItem.id],
          automaticSendInvocations: 0,
          holdClass: 'ordinary',
        },
      ],
    });
    const blocked = stepConductorCore(restored.state, {
      type: 'inbox.batch.start',
      batchId: 'recovery-batch',
      attemptId: 'recovery-blocked-by-size-gate',
      reason: 'restartRecovery',
    });
    expect(blocked.state).toBe(restored.state);
    expect(actions(blocked.effects)).toEqual([]);
    expect(blocked.state.dispatchHold).toBe(true);
    expect(blocked.state.durableInbox.stopGates).toEqual([
      { kind: 'sizeBlocked', batchId: 'size-batch' },
    ]);
  });

  it('ignores stale durable results and settles a finished result through shared lifecycle', () => {
    const item: ConductorInboxItem = {
      id: 'finished-item',
      payload: { text: 'complete this item' },
      holdClass: 'ordinary',
    };
    const restored = stepConductorCore(
      createConductorCoreState({ lastFailureClass: 'transport' }),
      {
        type: 'inbox.restore',
        pendingItems: [item],
        dispatchHold: false,
      },
    );
    const selected = stepConductorCore(restored.state, {
      type: 'inbox.batch.select',
      batchId: 'finished-batch',
      itemIds: [item.id],
    });
    const preflightPassed = stepConductorCore(selected.state, {
      type: 'inbox.sizePreflight.result',
      batchId: 'finished-batch',
      withinLimit: true,
    });
    const started = stepConductorCore(preflightPassed.state, {
      type: 'inbox.batch.start',
      batchId: 'finished-batch',
      attemptId: 'finished-attempt',
      reason: 'initial',
    });
    const invoked = stepConductorCore(started.state, {
      type: 'inbox.send.invoked',
      attemptId: 'finished-attempt',
    });

    const stale = stepConductorCore(invoked.state, {
      type: 'inbox.send.result',
      attemptId: 'stale-attempt',
      outcome: 'deliveryUnknown',
      failureClass: 'auth',
      agentAvailable: false,
    });
    expect(stale.state).toBe(invoked.state);
    expect(stale.effects).toEqual([]);

    const finished = stepConductorCore(invoked.state, {
      type: 'inbox.send.result',
      attemptId: 'finished-attempt',
      outcome: 'finished',
      agentAvailable: true,
    });
    expect(finished.state.lease).toBeUndefined();
    expect(finished.state.sendStartedAttemptId).toBeUndefined();
    expect(finished.state.agentAvailable).toBe(true);
    expect(finished.state.attentionAttemptId).toBeUndefined();
    expect(finished.state.lastFailureClass).toBeUndefined();
    expect(finished.state.durableInbox.stopGates).toEqual([
      { kind: 'ackPending', batchId: 'finished-batch' },
    ]);
    expect(canDispatchConductorCore(finished.state)).toBe(false);
    expect(observations(finished.effects)).toContainEqual({
      type: 'send.result',
      attemptId: 'finished-attempt',
      completed: true,
    });
    expect(actions(finished.effects)).toEqual([
      {
        type: 'persistInboxDeliveryAck',
        batchId: 'finished-batch',
        itemIds: [item.id],
      },
    ]);
  });

  it('keeps a durable inbox send in the shared lease across shutdown', () => {
    const item: ConductorInboxItem = {
      id: 'held-item',
      payload: { text: 'selected notice' },
      holdClass: 'ordinary',
    };
    const restored = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [item],
      dispatchHold: false,
    });
    const selected = stepConductorCore(restored.state, {
      type: 'inbox.batch.select',
      batchId: 'batch-1',
      itemIds: [item.id],
    });
    expect(actions(selected.effects)).toContainEqual({
      type: 'preflightInboxBatchSize',
      batchId: 'batch-1',
      itemIds: [item.id],
    });
    const startBeforePreflight = stepConductorCore(selected.state, {
      type: 'inbox.batch.start',
      batchId: 'batch-1',
      attemptId: 'attempt-1',
      reason: 'initial',
    });
    expect(actions(startBeforePreflight.effects)).toEqual([]);
    const preflightPassed = stepConductorCore(selected.state, {
      type: 'inbox.sizePreflight.result',
      batchId: 'batch-1',
      withinLimit: true,
    });
    const started = stepConductorCore(preflightPassed.state, {
      type: 'inbox.batch.start',
      batchId: 'batch-1',
      attemptId: 'attempt-1',
      reason: 'initial',
    });
    const startEffect = actions(started.effects).find(
      (action) => action.type === 'startInboxBatchSend',
    );
    expect(startEffect).toMatchObject({
      type: 'startInboxBatchSend',
      attemptId: 'attempt-1',
      batchId: 'batch-1',
      itemIds: [item.id],
    });
    expect(started.state.lease).toMatchObject({
      kind: 'send',
      purpose: 'durableInbox',
      attemptId: 'attempt-1',
      payload: startEffect,
    });
    expect(started.state.durableInbox.pendingItems).toEqual([item]);

    const shutdown = stepConductorCore(started.state, {
      type: 'session.shutdown',
      mode: 'signal',
    });
    expect(shutdown.state.lease).toEqual(started.state.lease);
    expect(shutdown.state.durableInbox.pendingItems).toEqual([item]);
    expect(actions(shutdown.effects)).toEqual([]);

    const staleRegularStarted = stepConductorCore(shutdown.state, {
      type: 'send.started',
      attemptId: 'attempt-1',
      sourceKey: 'inbox',
      events: [],
    });
    expect(staleRegularStarted.state.lease).toEqual(shutdown.state.lease);
    expect(observations(staleRegularStarted.effects)).toEqual([]);

    const invoked = stepConductorCore(shutdown.state, {
      type: 'inbox.send.invoked',
      attemptId: 'attempt-1',
    });
    expect(invoked.state.sendStartedAttemptId).toBe('attempt-1');
    expect(
      invoked.state.durableInbox.batches[0]?.automaticSendInvocations,
    ).toBe(1);
    expect(observations(invoked.effects)).toContainEqual({
      type: 'inbox.dispatched',
      attemptId: 'attempt-1',
      batchId: 'batch-1',
      itemIds: [item.id],
    });

    const finished = stepConductorCore(invoked.state, {
      type: 'inbox.send.result',
      attemptId: 'attempt-1',
      outcome: 'finished',
    });
    expect(finished.state.lease).toBeUndefined();
    expect(finished.state.sendStartedAttemptId).toBeUndefined();
    expect(finished.state.durableInbox.stopGates).toEqual([
      { kind: 'ackPending', batchId: 'batch-1' },
    ]);
    expect(actions(finished.effects)).toEqual([
      {
        type: 'persistInboxDeliveryAck',
        batchId: 'batch-1',
        itemIds: [item.id],
      },
    ]);
  });

  it('retries only a confirmed pre-invocation transient without counting a send', () => {
    const item: ConductorInboxItem = {
      id: 'transient-item',
      payload: { text: 'retry before provider invocation' },
      holdClass: 'ordinary',
    };
    const restored = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [item],
      dispatchHold: false,
    });
    const selected = stepConductorCore(restored.state, {
      type: 'inbox.batch.select',
      batchId: 'batch-1',
      itemIds: [item.id],
    });
    const preflightPassed = stepConductorCore(selected.state, {
      type: 'inbox.sizePreflight.result',
      batchId: 'batch-1',
      withinLimit: true,
    });
    const started = stepConductorCore(preflightPassed.state, {
      type: 'inbox.batch.start',
      batchId: 'batch-1',
      attemptId: 'attempt-before-call',
      reason: 'initial',
    });
    const notInvoked = stepConductorCore(started.state, {
      type: 'inbox.send.preInvocationTransientFailure',
      attemptId: 'attempt-before-call',
    });
    expect(notInvoked.state.lease).toBeUndefined();
    expect(notInvoked.state.durableInbox.batches[0]).toMatchObject({
      status: 'ready',
      automaticSendInvocations: 0,
      sendAttempt: undefined,
    });
    expect(actions(notInvoked.effects)).toEqual([
      {
        type: 'retryInboxSendBeforeInvocation',
        batchId: 'batch-1',
        itemIds: [item.id],
        reason: 'initial',
      },
    ]);

    const retryStarted = stepConductorCore(notInvoked.state, {
      type: 'inbox.batch.start',
      batchId: 'batch-1',
      attemptId: 'attempt-after-call',
      reason: 'initial',
    });
    const invoked = stepConductorCore(retryStarted.state, {
      type: 'inbox.send.invoked',
      attemptId: 'attempt-after-call',
    });
    expect(invoked.state.durableInbox.batches[0]).toMatchObject({
      automaticSendInvocations: 1,
    });
    const misreportedTransient = stepConductorCore(invoked.state, {
      type: 'inbox.send.preInvocationTransientFailure',
      attemptId: 'attempt-after-call',
    });
    expect(misreportedTransient.state.lease).toEqual(invoked.state.lease);
    expect(actions(misreportedTransient.effects)).toEqual([]);
  });

  it('does not let an exempt item make a mixed batch bypass a later hold', () => {
    const ordinary: ConductorInboxItem = {
      id: 'ordinary-item',
      payload: { text: 'ordinary' },
      holdClass: 'ordinary',
    };
    const recovery: ConductorInboxItem = {
      id: 'recovery-item',
      payload: { text: 'recovery' },
      holdClass: 'deliveryUnknown',
    };
    const restored = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [ordinary, recovery],
      dispatchHold: false,
    });
    const selected = stepConductorCore(restored.state, {
      type: 'inbox.batch.select',
      batchId: 'mixed-batch',
      itemIds: [ordinary.id, recovery.id],
    });
    const preflightPassed = stepConductorCore(selected.state, {
      type: 'inbox.sizePreflight.result',
      batchId: 'mixed-batch',
      withinLimit: true,
    });
    const holdSet = stepConductorCore(preflightPassed.state, {
      type: 'dispatchHold.set',
      enabled: true,
    });
    const blockedStart = stepConductorCore(holdSet.state, {
      type: 'inbox.batch.start',
      batchId: 'mixed-batch',
      attemptId: 'attempt-1',
      reason: 'initial',
    });
    expect(actions(blockedStart.effects)).toEqual([]);
    expect(blockedStart.state.durableInbox.batches[0]).toMatchObject({
      id: 'mixed-batch',
      status: 'ready',
      holdClass: 'ordinary',
    });
  });

  it('blocks hold bypass under a size stop and clears only the committed discard gate', () => {
    const sizeItem: ConductorInboxItem = {
      id: 'oversized-item',
      payload: { text: 'selected before the preflight result' },
      holdClass: 'ordinary',
    };
    const retryItem: ConductorInboxItem = {
      id: 'retry-item',
      payload: { text: 'unknown batch' },
      holdClass: 'deliveryUnknown',
    };
    const restored = stepConductorCore(createConductorCoreState(), {
      type: 'inbox.restore',
      pendingItems: [sizeItem, retryItem],
      dispatchHold: true,
      deliveryUnknownBatches: [
        {
          id: 'retry-batch',
          itemIds: [retryItem.id],
          automaticSendInvocations: 3,
          processResumeNotice: { text: 'resumed' },
        },
      ],
      sizeBlockedBatches: [
        {
          id: 'size-batch',
          itemIds: [sizeItem.id],
          automaticSendInvocations: 0,
          holdClass: 'ordinary',
        },
      ],
    });
    expect(restored.state.durableInbox.stopGates).toEqual([
      { kind: 'retryExhausted', batchId: 'retry-batch' },
      { kind: 'sizeBlocked', batchId: 'size-batch' },
    ]);
    const blocked = stepConductorCore(restored.state, {
      type: 'inbox.batch.start',
      batchId: 'retry-batch',
      attemptId: 'operator-resend',
      reason: 'operatorResend',
    });
    expect(actions(blocked.effects)).toEqual([]);

    const discard = stepConductorCore(blocked.state, {
      type: 'inbox.batch.discard',
      batchId: 'size-batch',
      gateKind: 'sizeBlocked',
    });
    expect(actions(discard.effects)).toContainEqual({
      type: 'persistInboxBatchDiscard',
      batchId: 'size-batch',
      itemIds: [sizeItem.id],
      gateKind: 'sizeBlocked',
    });
    expect(discard.state.durableInbox.stopGates).toHaveLength(2);

    const committed = stepConductorCore(discard.state, {
      type: 'inbox.batch.discard.result',
      batchId: 'size-batch',
      gateKind: 'sizeBlocked',
      committed: true,
    });
    expect(committed.state.durableInbox.pendingItems).toEqual([retryItem]);
    expect(committed.state.durableInbox.stopGates).toEqual([
      { kind: 'retryExhausted', batchId: 'retry-batch' },
    ]);
    const reimportedDiscard = stepConductorCore(committed.state, {
      type: 'inbox.accept',
      item: sizeItem,
    });
    expect(reimportedDiscard.state.durableInbox.pendingAcceptances).toEqual(
      [],
    );
    expect(actions(reimportedDiscard.effects)).toEqual([]);
  });
});
