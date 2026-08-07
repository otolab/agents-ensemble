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
