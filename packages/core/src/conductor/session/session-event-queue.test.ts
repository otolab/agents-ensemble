import { describe, expect, it } from 'vitest';
import { canDispatchConductorSend } from '../conductor-session-loop.js';
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
