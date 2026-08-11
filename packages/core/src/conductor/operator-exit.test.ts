import { describe, expect, it } from 'vitest';
import { isOperatorExitCommand } from './operator-exit.js';

describe('isOperatorExitCommand', () => {
  it('matches /exit and exit case-insensitively', () => {
    expect(isOperatorExitCommand('/exit')).toBe(true);
    expect(isOperatorExitCommand('  /EXIT  ')).toBe(true);
    expect(isOperatorExitCommand('exit')).toBe(true);
    expect(isOperatorExitCommand(' Exit ')).toBe(true);
  });

  it('does not match other input', () => {
    expect(isOperatorExitCommand('')).toBe(false);
    expect(isOperatorExitCommand('please exit now')).toBe(false);
    expect(isOperatorExitCommand('/quit')).toBe(false);
  });
});
