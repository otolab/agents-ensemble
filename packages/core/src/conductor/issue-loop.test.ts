import { describe, expect, it } from 'vitest';
import {
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
} from './issue-loop.js';

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
