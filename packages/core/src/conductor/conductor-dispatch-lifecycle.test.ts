import { describe, expect, it, vi } from 'vitest';
import {
  ConductorDispatchLifecycle,
  settleConductorDispatch,
} from './conductor-dispatch-lifecycle.js';
import { ConductorRecoveryInbox } from './conductor-recovery-inbox.js';

describe('ConductorDispatchLifecycle', () => {
  it('owns one send until it is settled', () => {
    const lifecycle = new ConductorDispatchLifecycle<{ events: string[] }>();
    const lease = lifecycle.beginSend({ events: ['first'] });

    expect(lease).toMatchObject({
      kind: 'send',
      payload: { events: ['first'] },
    });
    expect(lifecycle.state).toBe('in_flight');
    expect(lifecycle.beginSend({ events: ['second'] })).toBeUndefined();

    lifecycle.settleSend(lease!, { completed: true });
    expect(lifecycle.state).toBe('ready');
    expect(lifecycle.beginSend({ events: ['second'] })?.payload.events).toEqual([
      'second',
    ]);
  });

  it('requires explicit confirmation after an incomplete send', () => {
    const lifecycle = new ConductorDispatchLifecycle<string>();
    const lease = lifecycle.beginSend('operator input')!;

    lifecycle.settleSend(lease, {
      completed: false,
      failureClass: 'transport',
    });

    expect(lifecycle.state).toBe('attention');
    expect(lifecycle.pendingAttemptId).toBe(lease.attemptId);
    expect(lifecycle.lastFailure).toBe('transport');
    expect(lifecycle.beginSend('later input')).toBeUndefined();
    expect(lifecycle.confirmRecovery()).toBe(true);
    expect(lifecycle.state).toBe('ready');
    expect(lifecycle.lastFailure).toBe('transport');
  });

  it('keeps availability and confirmation as independent state', () => {
    const lifecycle = new ConductorDispatchLifecycle<void>();
    const failedSend = lifecycle.beginSend(undefined)!;
    lifecycle.settleSend(failedSend, {
      completed: false,
      agentAvailable: false,
    });

    expect(lifecycle.state).toBe('unavailable');
    expect(lifecycle.confirmationRequired).toBe(true);
    expect(lifecycle.beginSend(undefined)).toBeUndefined();

    const reconnect = lifecycle.beginReconnect()!;
    lifecycle.settleReconnect(reconnect, true);
    expect(lifecycle.state).toBe('attention');
    expect(lifecycle.confirmationRequired).toBe(true);

    expect(lifecycle.confirmRecovery()).toBe(true);
    expect(lifecycle.state).toBe('ready');
  });

  it('does not impose confirmation on workflow-specific retry settlements', () => {
    const lifecycle = new ConductorDispatchLifecycle<string>();
    const lease = lifecycle.beginSend('watch report')!;

    lifecycle.settleSend(lease, {
      completed: false,
      requiresConfirmation: false,
    });

    expect(lifecycle.state).toBe('ready');
  });

  it('keeps Issue running results normal while gating operator-agent user input', () => {
    const issueLifecycle = new ConductorDispatchLifecycle<string>();
    const issueInbox = new ConductorRecoveryInbox();
    const issueLease = issueLifecycle.beginSend('issue input')!;
    const issueReservation = issueInbox.reserve(['issue input']);
    if (!issueReservation.ok || !issueReservation.reservation) {
      throw new Error('Expected an Issue recovery reservation.');
    }

    const issueResult = settleConductorDispatch({
      lifecycle: issueLifecycle,
      lease: issueLease,
      inbox: issueInbox,
      reservation: issueReservation.reservation,
      workflow: 'issue',
      backend: 'cursor',
      sendCount: 1,
      sourceKey: 'operator',
      eventTypes: ['operator.message'],
      operatorInputTexts: ['issue input'],
      result: { runId: 'issue-run', status: 'running' },
      toolCallStarted: false,
    });

    expect(issueResult.completed).toBe(true);
    expect(issueLifecycle.state).toBe('ready');
    expect(issueInbox.list()).toEqual([]);

    const operatorLifecycle = new ConductorDispatchLifecycle<string>();
    const operatorInbox = new ConductorRecoveryInbox();
    const operatorLease = operatorLifecycle.beginSend('operator input')!;
    const operatorReservation = operatorInbox.reserve(['operator input']);
    if (!operatorReservation.ok || !operatorReservation.reservation) {
      throw new Error('Expected an operator-agent recovery reservation.');
    }

    const operatorResult = settleConductorDispatch({
      lifecycle: operatorLifecycle,
      lease: operatorLease,
      inbox: operatorInbox,
      reservation: operatorReservation.reservation,
      workflow: 'operator-agent',
      backend: 'cursor',
      sendCount: 1,
      sourceKey: 'user',
      eventTypes: ['operator.message'],
      operatorInputTexts: ['operator input'],
      result: { runId: 'operator-run', status: 'running' },
      toolCallStarted: false,
      requiresConfirmation: true,
    });

    expect(operatorResult.completed).toBe(false);
    expect(operatorLifecycle.confirmationRequired).toBe(true);
    expect(
      operatorInbox.get(operatorResult.snapshot!.recoveryId)?.inputTexts,
    ).toEqual(['operator input']);
    issueInbox.dispose();
    operatorInbox.dispose();
  });

  it('notifies subscribers when an operator confirms recovery', () => {
    const lifecycle = new ConductorDispatchLifecycle<void>();
    const lease = lifecycle.beginSend(undefined)!;
    lifecycle.settleSend(lease, { completed: false });
    const listener = vi.fn();
    lifecycle.subscribe(listener);

    lifecycle.confirmRecovery();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('rejects a stale lease instead of settling another attempt', () => {
    const lifecycle = new ConductorDispatchLifecycle<string>();
    const first = lifecycle.beginSend('first')!;
    lifecycle.settleSend(first, { completed: true });
    const second = lifecycle.beginSend('second')!;

    expect(() =>
      lifecycle.settleSend(first, { completed: false }),
    ).toThrow('Cannot settle inactive conductor send lease.');
    expect(lifecycle.state).toBe('in_flight');

    lifecycle.settleSend(second, { completed: true });
  });
});
