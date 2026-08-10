import { describe, expect, it } from 'vitest';
import { canDispatchConductorSend } from './conductor-session-loop.js';

describe('canDispatchConductorSend', () => {
  it('allows operator.message at max turns', () => {
    expect(
      canDispatchConductorSend(
        { type: 'operator.message', text: 'continue' },
        5,
        5,
      ),
    ).toBe(true);
  });

  it('blocks worker.completed at max turns', () => {
    expect(
      canDispatchConductorSend(
        {
          type: 'worker.completed',
          result: {
            name: 'worker',
            acpSessionId: 'sess-1',
            status: 'finished',
            result: 'ok',
          },
        },
        5,
        5,
      ),
    ).toBe(false);
  });

  it('allows worker.completed below max turns', () => {
    expect(
      canDispatchConductorSend(
        {
          type: 'worker.completed',
          result: {
            name: 'worker',
            acpSessionId: 'sess-1',
            status: 'finished',
            result: 'ok',
          },
        },
        4,
        5,
      ),
    ).toBe(true);
  });
});
