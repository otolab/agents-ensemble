import { describe, expect, it } from 'vitest';
import { WorkerOutboundQueue } from './worker-outbound-queue.js';

describe('WorkerOutboundQueue', () => {
  it('delegates enqueue to handler', () => {
    const queue = new WorkerOutboundQueue((worker, instruction) => ({
      status: 'sent',
      worker,
      message: instruction,
    }));

    expect(queue.enqueue('implementer', 'do work')).toEqual({
      status: 'sent',
      worker: 'implementer',
      message: 'do work',
    });
  });
});
