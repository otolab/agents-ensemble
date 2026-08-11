import { describe, expect, it, vi } from 'vitest';
import { createTestOperatorInputBinding } from './test-operator-input-binding.js';

describe('createTestOperatorInputBinding', () => {
  it('submits on bind by default', () => {
    const submit = vi.fn(() => true);
    const binding = createTestOperatorInputBinding(() => 'hello');
    binding.bindOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 5,
        openQuestions: [],
      }),
    });
    expect(submit).toHaveBeenCalledWith('hello');
  });

  it('skips submit on bind when submitOnBind is false', () => {
    const submit = vi.fn(() => true);
    const binding = createTestOperatorInputBinding(() => 'hello', {
      submitOnBind: false,
    });
    binding.bindOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 5,
        openQuestions: [],
      }),
    });
    expect(submit).not.toHaveBeenCalled();
    expect(binding.trySubmit()).toBe(true);
  });
});
