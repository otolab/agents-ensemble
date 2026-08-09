import { describe, expect, it, vi } from 'vitest';
import {
  ensureMaxTurnsOpenQuestion,
  MAX_TURNS_OPEN_QUESTION_TEXT,
} from './enqueue-max-turns-question.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('ensureMaxTurnsOpenQuestion', () => {
  it('enqueues a max_turns open question', () => {
    const registry = new OpenQuestionRegistry();

    const entry = ensureMaxTurnsOpenQuestion(registry, {
      issueUrl: 'https://github.com/org/repo/issues/1',
      autonomousTurns: 5,
      maxTurns: 5,
      turnCount: 5,
      workerDispatchCount: 1,
      workerFailureCount: 0,
      lastResult: 'done for now',
    });

    expect(entry.question).toBe(MAX_TURNS_OPEN_QUESTION_TEXT);
    expect(entry.source).toBe('max_turns');
    expect(registry.openCount).toBe(1);
  });

  it('does not duplicate an existing max_turns open question', () => {
    const registry = new OpenQuestionRegistry();
    const onEnqueued = vi.fn();
    const input = {
      issueUrl: 'https://github.com/org/repo/issues/1',
      autonomousTurns: 5,
      maxTurns: 5,
      turnCount: 5,
      workerDispatchCount: 0,
      workerFailureCount: 0,
    };

    const first = ensureMaxTurnsOpenQuestion(registry, input, onEnqueued);
    const second = ensureMaxTurnsOpenQuestion(registry, input, onEnqueued);

    expect(second.id).toBe(first.id);
    expect(registry.openCount).toBe(1);
    expect(onEnqueued).toHaveBeenCalledOnce();
  });
});
