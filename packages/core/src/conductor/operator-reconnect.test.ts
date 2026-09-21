import { describe, expect, it } from 'vitest';
import { isOperatorReconnectCommand } from './operator-reconnect.js';

describe('isOperatorReconnectCommand', () => {
  it('matches /reconnect and reconnect case-insensitively', () => {
    expect(isOperatorReconnectCommand('/reconnect')).toBe(true);
    expect(isOperatorReconnectCommand('  /RECONNECT  ')).toBe(true);
    expect(isOperatorReconnectCommand('reconnect')).toBe(true);
    expect(isOperatorReconnectCommand(' Reconnect ')).toBe(true);
  });

  it('does not match other input', () => {
    expect(isOperatorReconnectCommand('')).toBe(false);
    expect(isOperatorReconnectCommand('please reconnect now')).toBe(false);
    expect(isOperatorReconnectCommand('/exit')).toBe(false);
  });
});
