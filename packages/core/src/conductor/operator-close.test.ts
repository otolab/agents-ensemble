import { describe, expect, it } from 'vitest';
import { isOperatorCloseCommand } from './operator-close.js';

describe('isOperatorCloseCommand', () => {
  it('matches /close and close case-insensitively', () => {
    expect(isOperatorCloseCommand('/close')).toBe(true);
    expect(isOperatorCloseCommand('  /CLOSE  ')).toBe(true);
    expect(isOperatorCloseCommand('close')).toBe(true);
    expect(isOperatorCloseCommand(' Close ')).toBe(true);
  });

  it('does not match other input', () => {
    expect(isOperatorCloseCommand('')).toBe(false);
    expect(isOperatorCloseCommand('please close now')).toBe(false);
    expect(isOperatorCloseCommand('/exit')).toBe(false);
  });
});
