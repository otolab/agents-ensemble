import { describe, expect, it } from 'vitest';
import {
  autonomousTurnsAfterConductorSend,
  autonomousTurnsAfterConductorBatch,
  canDispatchConductorSend,
  isMaxTurnsLimited,
  operatorInputMaxTurns,
  resolveIssueLoopStopReason,
  resolveMaxTurns,
  shouldStopIssueLoop,
} from './session-policy.js';

describe('resolveMaxTurns', () => {
  it('returns default when undefined', () => {
    expect(resolveMaxTurns()).toBe(5);
  });

  it('returns explicit value including unlimited', () => {
    expect(resolveMaxTurns(10)).toBe(10);
    expect(resolveMaxTurns(0)).toBe(0);
    expect(resolveMaxTurns(-1)).toBe(-1);
  });
});

describe('isMaxTurnsLimited', () => {
  it('is false for zero or negative', () => {
    expect(isMaxTurnsLimited(0)).toBe(false);
    expect(isMaxTurnsLimited(-1)).toBe(false);
  });

  it('is true for positive', () => {
    expect(isMaxTurnsLimited(1)).toBe(true);
    expect(isMaxTurnsLimited(5)).toBe(true);
  });
});

describe('operatorInputMaxTurns', () => {
  it('returns null when unlimited', () => {
    expect(operatorInputMaxTurns(0)).toBeNull();
  });

  it('returns value when limited', () => {
    expect(operatorInputMaxTurns(5)).toBe(5);
  });
});

describe('shouldStopIssueLoop', () => {
  it('stops on error', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 1,
        maxTurns: 5,
        lastStatus: 'error',
        dispatchesThisTurn: 0,
      }),
    ).toBe(true);
  });

  it('continues on error when continueOnConductorError is set', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 1,
        maxTurns: 5,
        lastStatus: 'error',
        dispatchesThisTurn: 0,
        continueOnConductorError: true,
      }),
    ).toBe(false);
  });

  it('stops when finished without dispatches', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
      }),
    ).toBe(true);
  });

  it('continues after a dispatch', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 3,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 1,
      }),
    ).toBe(false);
  });

  it('continues while workers are still running', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        runningWorkers: 1,
      }),
    ).toBe(false);
  });

  it('continues while pending permissions await conductor resolution', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        pendingPermissions: 1,
      }),
    ).toBe(false);
  });

  it('continues while open questions await operator answer', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        openQuestions: 1,
      }),
    ).toBe(false);
  });

  it('does not stop only because autonomous turns reached maxTurns', () => {
    expect(
      shouldStopIssueLoop({
        autonomousTurns: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 1,
      }),
    ).toBe(false);
  });
});

describe('resolveIssueLoopStopReason', () => {
  it('returns completed for a successful conductor turn', () => {
    expect(
      resolveIssueLoopStopReason({
        autonomousTurns: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 1,
      }),
    ).toBe('completed');
  });
});

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

  it('allows worker.completed at max turns when unlimited', () => {
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
        100,
        0,
      ),
    ).toBe(true);
  });
});

describe('autonomousTurnsAfterConductorBatch', () => {
  it('resets when batch includes operator.message', () => {
    expect(
      autonomousTurnsAfterConductorBatch(
        [
          { type: 'operator.message', text: 'a' },
          { type: 'operator.message', text: 'b' },
        ],
        5,
      ),
    ).toBe(0);
  });

  it('increments once per batch without operator', () => {
    expect(
      autonomousTurnsAfterConductorBatch(
        [
          {
            type: 'worker.completed',
            result: {
              name: 'worker',
              acpSessionId: 'sess-1',
              status: 'finished',
              result: 'ok',
            },
          },
        ],
        2,
      ),
    ).toBe(3);
  });
});

describe('autonomousTurnsAfterConductorSend', () => {
  it('resets on operator.message', () => {
    expect(
      autonomousTurnsAfterConductorSend(
        { type: 'operator.message', text: 'go' },
        5,
      ),
    ).toBe(0);
  });

  it('increments on worker.completed', () => {
    expect(
      autonomousTurnsAfterConductorSend(
        {
          type: 'worker.completed',
          result: {
            name: 'worker',
            acpSessionId: 'sess-1',
            status: 'finished',
            result: 'ok',
          },
        },
        2,
      ),
    ).toBe(3);
  });
});
