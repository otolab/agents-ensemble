import { describe, expect, it } from 'vitest';
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
});
