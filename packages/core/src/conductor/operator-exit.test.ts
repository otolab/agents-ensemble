import { describe, expect, it } from 'vitest';
import { isOperatorExitCommand } from './operator-exit.js';

describe('isOperatorExitCommand', () => {
  it('matches the exit command and its alias', () => {
    expect(isOperatorExitCommand('/exit')).toBe(true);
    expect(isOperatorExitCommand('exit')).toBe(true);
  });

  it('does not claim another operator command or partial input', () => {
    expect(isOperatorExitCommand('please exit now')).toBe(false);
    expect(isOperatorExitCommand('/close')).toBe(false);
    expect(isOperatorExitCommand('/reconnect')).toBe(false);
    expect(isOperatorExitCommand('/quit')).toBe(false);
  });
});
