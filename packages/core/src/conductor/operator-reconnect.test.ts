import { describe, expect, it } from 'vitest';
import { isOperatorReconnectCommand } from './operator-reconnect.js';

describe('isOperatorReconnectCommand', () => {
  it('matches the reconnect command without a slashless alias', () => {
    expect(isOperatorReconnectCommand('/reconnect')).toBe(true);
    expect(isOperatorReconnectCommand('reconnect')).toBe(false);
  });

  it('does not claim another operator command or partial input', () => {
    expect(isOperatorReconnectCommand('please reconnect now')).toBe(false);
    expect(isOperatorReconnectCommand('/close')).toBe(false);
    expect(isOperatorReconnectCommand('/exit')).toBe(false);
  });
});
