import { describe, expect, it } from 'vitest';
import { createOperatorPostLoopGate } from './operator-post-loop-gate.js';

describe('createOperatorPostLoopGate', () => {
  it('resolves resume when notified during wait', async () => {
    const gate = createOperatorPostLoopGate();
    const controller = new AbortController();
    const waitPromise = gate.wait(controller.signal);
    expect(gate.isWaiting()).toBe(true);
    gate.notifyResume();
    await expect(waitPromise).resolves.toBe('resume');
    expect(gate.isWaiting()).toBe(false);
  });

  it('resolves exit when notified during wait', async () => {
    const gate = createOperatorPostLoopGate();
    const controller = new AbortController();
    const waitPromise = gate.wait(controller.signal);
    gate.notifyExit();
    await expect(waitPromise).resolves.toBe('exit');
  });

  it('resolves exit immediately when signal is already aborted', async () => {
    const gate = createOperatorPostLoopGate();
    const controller = new AbortController();
    controller.abort();
    await expect(gate.wait(controller.signal)).resolves.toBe('exit');
  });

  it('resolves exit when signal aborts during wait', async () => {
    const gate = createOperatorPostLoopGate();
    const controller = new AbortController();
    const waitPromise = gate.wait(controller.signal);
    controller.abort();
    await expect(waitPromise).resolves.toBe('exit');
  });
});
