import { describe, expect, it } from 'vitest';
import { formatOperatorContextHint } from './format-operator-context.js';

describe('formatOperatorContextHint', () => {
  it('returns default prompt when context is undefined', () => {
    expect(formatOperatorContextHint(undefined)).toBe('operator> ');
  });

  it('highlights open questions', () => {
    expect(
      formatOperatorContextHint({
        conductorTurn: 2,
        autonomousTurns: 1,
        maxTurns: 5,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Continue?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
          },
        ],
      }),
    ).toContain('open question');
  });

  it('shows autonomous turn progress', () => {
    expect(
      formatOperatorContextHint({
        conductorTurn: 1,
        autonomousTurns: 2,
        maxTurns: null,
        openQuestions: [],
      }),
    ).toContain('2/∞');
  });
});
