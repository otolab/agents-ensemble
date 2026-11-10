import { describe, expect, it } from 'vitest';
import { canDispatchConductorSend } from '../session-policy.js';
import { SessionEventQueue } from './session-event-queue.js';

describe('SessionEventQueue', () => {
  it('dequeues enqueued events in order', () => {
    const queue = new SessionEventQueue();
    queue.enqueue({ type: 'operator.message', text: 'hello' });
    queue.enqueue({ type: 'operator.message', text: 'world' });

    expect(queue.dequeue()?.type).toBe('operator.message');
    expect(queue.dequeue()?.type).toBe('operator.message');
    expect(queue.isEmpty()).toBe(true);
  });

  it('resolves waitForEvent when enqueue happens later', async () => {
    const queue = new SessionEventQueue();
    const pending = queue.waitForEvent();
    queue.enqueue({ type: 'operator.message', text: 'later' });

    await expect(pending).resolves.toEqual({
      type: 'operator.message',
      text: 'later',
    });
  });

  it('rejects waitForEvent when the abort signal fires', async () => {
    const queue = new SessionEventQueue();
    const controller = new AbortController();
    const pending = queue.waitForEvent(controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('waits for reconnect without consuming or reordering other events', async () => {
    const queue = new SessionEventQueue();
    const first = { type: 'operator.message' as const, text: 'queued first' };
    const worker = {
      type: 'worker.completed' as const,
      result: {
        name: 'worker',
        acpSessionId: 'sess-1',
        status: 'finished' as const,
        result: 'done',
      },
    };
    const last = { type: 'operator.message' as const, text: 'queued last' };
    const reconnect = { type: 'operator.reconnect' as const };
    queue.enqueue(first);

    const pending = queue.waitForMatchingEvent(
      (event) => event.type === 'operator.reconnect',
    );
    queue.enqueue(worker);
    queue.enqueue(last);
    queue.enqueue(reconnect);

    await expect(pending).resolves.toEqual(reconnect);
    expect(queue.snapshot()).toEqual([first, worker, last]);
  });

  it('finds a queued reconnect while preserving earlier messages', async () => {
    const queue = new SessionEventQueue();
    const message = { type: 'operator.message' as const, text: 'keep me' };
    const reconnect = { type: 'operator.reconnect' as const };
    const worker = {
      type: 'worker.completed' as const,
      result: {
        name: 'worker',
        acpSessionId: 'sess-1',
        status: 'finished' as const,
        result: 'done',
      },
    };
    queue.enqueue(message);
    queue.enqueue(reconnect);
    queue.enqueue(worker);

    await expect(
      queue.waitForMatchingEvent((event) => event.type === 'operator.reconnect'),
    ).resolves.toEqual(reconnect);
    expect(queue.snapshot()).toEqual([message, worker]);
  });

  it('coalesces matching events while preserving other events in order', () => {
    const queue = new SessionEventQueue();
    const firstMessage = { type: 'operator.message' as const, text: 'first' };
    const firstReconnect = { type: 'operator.reconnect' as const };
    const worker = {
      type: 'worker.completed' as const,
      result: {
        name: 'worker',
        acpSessionId: 'sess-1',
        status: 'finished' as const,
        result: 'done',
      },
    };
    const lastMessage = { type: 'operator.message' as const, text: 'last' };
    const secondReconnect = { type: 'operator.reconnect' as const };
    queue.enqueue(firstMessage);
    queue.enqueue(firstReconnect);
    queue.enqueue(worker);
    queue.enqueue(lastMessage);
    queue.enqueue(secondReconnect);

    expect(
      queue.findSendEvents((event) => event.type === 'operator.reconnect'),
    ).toEqual([firstReconnect, secondReconnect]);
    expect(queue.snapshot()).toEqual([firstMessage, worker, lastMessage]);
  });

  it('waitForSendEvent skips blocked events until operator.message arrives', async () => {
    const queue = new SessionEventQueue();
    queue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'worker',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'ok',
      },
    });

    const pending = queue.waitForSendEvent({
      accept: (event) => canDispatchConductorSend(event, 5, 5),
    });

    queue.enqueue({ type: 'operator.message', text: 'continue' });

    await expect(pending).resolves.toEqual({
      type: 'operator.message',
      text: 'continue',
    });
    expect(queue.dequeue()?.type).toBe('worker.completed');
  });
});
