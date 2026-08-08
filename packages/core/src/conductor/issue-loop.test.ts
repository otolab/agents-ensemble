import { describe, expect, it } from 'vitest';
import {
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
} from './issue-loop.js';

describe('shouldStopIssueLoop', () => {
  it('stops on error', () => {
    expect(
      shouldStopIssueLoop({
        turn: 1,
        maxTurns: 5,
        lastStatus: 'error',
        dispatchesThisTurn: 0,
      }),
    ).toBe(true);
  });

  it('stops when finished without dispatches', () => {
    expect(
      shouldStopIssueLoop({
        turn: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
      }),
    ).toBe(true);
  });

  it('continues after a dispatch within max turns', () => {
    expect(
      shouldStopIssueLoop({
        turn: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 1,
      }),
    ).toBe(false);
  });

  it('stops at max turns even after dispatches', () => {
    expect(
      shouldStopIssueLoop({
        turn: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 1,
      }),
    ).toBe(true);
  });

  it('continues while workers are still running before max turns', () => {
    expect(
      shouldStopIssueLoop({
        turn: 2,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        runningWorkers: 1,
      }),
    ).toBe(false);
  });

  it('continues at max turns while workers are still running', () => {
    expect(
      shouldStopIssueLoop({
        turn: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 1,
        runningWorkers: 1,
      }),
    ).toBe(false);
  });

  it('continues while pending permissions await conductor resolution', () => {
    expect(
      shouldStopIssueLoop({
        turn: 2,
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
        turn: 1,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 0,
        openQuestions: 1,
      }),
    ).toBe(false);
  });
});

describe('resolveIssueLoopStopReason', () => {
  it('returns max_turns when limit hit after dispatches', () => {
    expect(
      resolveIssueLoopStopReason({
        turn: 5,
        maxTurns: 5,
        lastStatus: 'finished',
        dispatchesThisTurn: 1,
      }),
    ).toBe('max_turns');
  });
});
