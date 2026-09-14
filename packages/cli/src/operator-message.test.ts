import { describe, expect, it } from 'vitest';
import {
  OPERATOR_MESSAGE_ENV,
  normalizeInitialOperatorMessage,
  resolveInitialOperatorMessage,
} from './operator-message.js';

describe('normalizeInitialOperatorMessage', () => {
  it('joins variadic CLI words with one space and trims the result', () => {
    expect(normalizeInitialOperatorMessage(['  start', 'with', 'the task  '])).toBe(
      'start with the task',
    );
  });

  it('treats blank CLI input as unspecified', () => {
    expect(normalizeInitialOperatorMessage(['  ', ''])).toBeUndefined();
    expect(normalizeInitialOperatorMessage('  ')).toBeUndefined();
  });
});

describe('resolveInitialOperatorMessage', () => {
  it('uses the CLI message when the environment is blank', () => {
    expect(
      resolveInitialOperatorMessage('from cli', {
        [OPERATOR_MESSAGE_ENV]: '  ',
      }),
    ).toBe('from cli');
  });

  it('uses the environment message when the CLI message is absent', () => {
    expect(
      resolveInitialOperatorMessage(undefined, {
        [OPERATOR_MESSAGE_ENV]: ' from env ',
      }),
    ).toBe('from env');
  });

  it('rejects non-blank CLI and environment messages together', () => {
    expect(() =>
      resolveInitialOperatorMessage('from cli', {
        [OPERATOR_MESSAGE_ENV]: 'from env',
      }),
    ).toThrow(
      `Cannot use a CLI operator message together with ${OPERATOR_MESSAGE_ENV}; provide only one.`,
    );
  });
});
