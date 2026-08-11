import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOperatorInputInteractive,
  promptOperatorInput,
} from './prompt-operator-input.js';

describe('isOperatorInputInteractive', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true when ENSEMBLE_OPERATOR_MESSAGE is set', () => {
    vi.stubEnv('ENSEMBLE_OPERATOR_MESSAGE', 'hello');
    expect(isOperatorInputInteractive()).toBe(true);
  });

  it('returns false when non-TTY and no env message', () => {
    vi.stubEnv('ENSEMBLE_OPERATOR_MESSAGE', '');
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const original = stdin.isTTY;
    stdin.isTTY = false;
    try {
      expect(isOperatorInputInteractive()).toBe(false);
    } finally {
      stdin.isTTY = original;
    }
  });
});

describe('promptOperatorInput', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns env message without TTY', async () => {
    vi.stubEnv('ENSEMBLE_OPERATOR_MESSAGE', 'from-env');
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const original = stdin.isTTY;
    stdin.isTTY = false;
    try {
      await expect(
        promptOperatorInput({
          conductorTurn: 1,
          autonomousTurns: 0,
          maxTurns: null,
          openQuestions: [],
        }),
      ).resolves.toBe('from-env');
    } finally {
      stdin.isTTY = original;
    }
  });
});
