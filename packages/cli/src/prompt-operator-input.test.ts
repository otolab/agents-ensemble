import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOperatorInputInteractive,
  isOperatorInputTty,
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

describe('isOperatorInputTty', () => {
  it('returns true only for stdin TTY', () => {
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const original = stdin.isTTY;
    stdin.isTTY = true;
    try {
      expect(isOperatorInputTty()).toBe(true);
    } finally {
      stdin.isTTY = original;
    }
  });

  it('returns false for non-TTY even when ENSEMBLE_OPERATOR_MESSAGE is set', () => {
    vi.stubEnv('ENSEMBLE_OPERATOR_MESSAGE', 'hello');
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const original = stdin.isTTY;
    stdin.isTTY = false;
    try {
      expect(isOperatorInputInteractive()).toBe(true);
      expect(isOperatorInputTty()).toBe(false);
    } finally {
      stdin.isTTY = original;
      vi.unstubAllEnvs();
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
