import { describe, expect, it } from 'vitest';
import { resolveCliMaxTurns } from './resolve-cli-max-turns.js';

describe('resolveCliMaxTurns', () => {
  it('returns 0 for interactive default (unlimited)', () => {
    expect(resolveCliMaxTurns({ interactive: true })).toBe(0);
  });

  it('returns 5 for non-interactive default', () => {
    expect(resolveCliMaxTurns({ interactive: false })).toBe(5);
  });

  it('returns 0 when --no-max-turns is set', () => {
    expect(
      resolveCliMaxTurns({ interactive: false, noMaxTurns: true }),
    ).toBe(0);
  });

  it('uses explicit --max-turns value', () => {
    expect(
      resolveCliMaxTurns({ interactive: true, maxTurns: 10 }),
    ).toBe(10);
  });

  it('treats --max-turns 0 as unlimited', () => {
    expect(
      resolveCliMaxTurns({ interactive: false, maxTurns: 0 }),
    ).toBe(0);
  });

  it('prefers --no-max-turns over --max-turns', () => {
    expect(
      resolveCliMaxTurns({
        interactive: false,
        noMaxTurns: true,
        maxTurns: 10,
      }),
    ).toBe(0);
  });
});
